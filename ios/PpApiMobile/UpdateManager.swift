import Foundation
import UIKit

/// In-app updater for iOS: streams the unsigned IPA from the GitHub release with
/// live progress, keeps resume data so a slow link never loses work, and exports
/// the finished file through the share sheet (installing still needs a signature).
final class UpdateManager: NSObject, URLSessionDownloadDelegate {
    static let shared = UpdateManager()

    static let assetName = "Pp-API-iOS-unsigned.ipa"
    private static let latest = URL(string: "https://api.github.com/repos/Aigooz/pp-api-mobile/releases/latest")!
    private static let maxAttempts = 20

    /// Called on the main thread with (status, payload) for window.__nativeUpdate.
    var onStatus: ((String, [String: Any]) -> Void)?
    /// Same payload, pushed through window.__ppUpdateTick so the page can refresh
    /// the visible progress without re-rendering the whole update view.
    var onTick: (([String: Any]) -> Void)?
    /// Called when the page asks to install/export the finished package.
    var onExport: ((URL) -> Void)?

    private var session: URLSession?
    private var download: URLSessionDownloadTask?
    private var resumeData: Data?
    private var releaseInfo: [String: Any] = [:]
    private var savedFile: URL?
    private var lastTick = Date()
    private var lastBytes: Int64 = 0
    private var lastPublish = Date.distantPast

    private(set) var downloaded: Int64 = 0
    private(set) var total: Int64 = 0
    private(set) var speed: Int64 = 0
    private(set) var attempt = 1
    private(set) var state = "idle"
    private(set) var message = ""
    private var busy = false

    static func currentVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    static func compare(_ lhs: String, _ rhs: String) -> Int {
        let left = lhs.split(separator: ".").map { Int($0) ?? 0 }
        let right = rhs.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a != b { return a > b ? 1 : -1 }
        }
        return 0
    }

    func snapshot() -> String {
        let payload: [String: Any] = [
            "downloaded": downloaded, "total": total, "speed": speed,
            "attempt": attempt, "state": state, "message": message,
            "running": state == "downloading"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    private func publish(_ status: String, tick: Bool = false) {
        var payload = releaseInfo
        payload["downloaded"] = downloaded
        payload["total"] = total > 0 ? total : (releaseInfo["size"] as? Int ?? 0)
        payload["speed"] = speed
        payload["attempt"] = attempt
        payload["state"] = state
        payload["message"] = message
        if tick { payload["tick"] = true }
        if tick { onTick?(payload) } else { onStatus?(status, payload) }
    }

    private func fail(_ text: String) {
        busy = false
        state = "error"
        message = text
        speed = 0
        publish("error")
    }

    // MARK: - Check

    func check() {
        guard !busy else { return }
        state = "checking"
        message = ""
        publish("checking")
        var request = URLRequest(url: Self.latest, timeoutInterval: 30)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("PpApiMobile-iOS", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard error == nil, let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = json["tag_name"] as? String else {
                    self.fail(error?.localizedDescription ?? "无法连接 GitHub 检查更新")
                    return
                }
                let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
                guard Self.compare(version, Self.currentVersion()) > 0 else {
                    self.releaseInfo = [:]
                    self.savedFile = nil
                    self.state = "current"
                    self.message = ""
                    self.publish("current")
                    return
                }
                let assets = json["assets"] as? [[String: Any]] ?? []
                guard let asset = assets.first(where: { ($0["name"] as? String) == Self.assetName }),
                      let url = asset["browser_download_url"] as? String else {
                    self.fail("该版本没有提供 iOS 安装包")
                    return
                }
                self.releaseInfo = [
                    "version": version,
                    "tag": tag,
                    "notes": json["body"] as? String ?? "",
                    "url": url,
                    "size": asset["size"] as? Int ?? 0
                ]
                self.state = "available"
                self.message = ""
                self.publish("available")
            }
        }.resume()
    }

    // MARK: - Download

    func resume() {
        if state == "downloading" && busy { publish("downloading"); return }
        guard let file = savedFile, FileManager.default.fileExists(atPath: file.path),
              let version = releaseInfo["version"] as? String,
              Self.compare(version, Self.currentVersion()) > 0 else {
            if !releaseInfo.isEmpty { publish("available") }
            return
        }
        state = "ready"
        downloaded = fileSize(file)
        total = max(total, downloaded)
        publish("ready")
    }

    func startDownload() {
        guard !busy else { return }
        guard !releaseInfo.isEmpty, let url = releaseInfo["url"] as? String, URL(string: url) != nil else {
            check()
            return
        }
        attempt = 1
        downloaded = 0
        total = 0
        resumeData = nil
        savedFile = nil
        state = "downloading"
        message = ""
        publish("downloading")
        startTask()
    }

    func cancel() {
        guard state == "downloading" else { return }
        let task = download
        download = nil
        busy = false
        state = "cancelled"
        message = "已取消下载"
        speed = 0
        task?.cancel(byProducingResumeData: { [weak self] data in
            self?.resumeData = data
        })
        publish("error")
    }

    func install() {
        guard let file = savedFile, FileManager.default.fileExists(atPath: file.path) else {
            fail("请先下载更新")
            return
        }
        onExport?(file)
    }

    private func startTask() {
        guard let raw = releaseInfo["url"] as? String, let url = URL(string: raw) else {
            fail("下载地址无效")
            return
        }
        busy = true
        lastTick = Date()
        lastBytes = downloaded
        let configuration = URLSessionConfiguration.default
        // The request timeout is the idle gap between packets, not the whole
        // transfer, so a slow link keeps going as long as data still arrives.
        configuration.timeoutIntervalForRequest = 180
        configuration.timeoutIntervalForResource = 60 * 60 * 24 * 2
        session?.invalidateAndCancel()
        let created = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        session = created
        let task: URLSessionDownloadTask
        if let data = resumeData {
            task = created.downloadTask(withResumeData: data)
            resumeData = nil
        } else {
            var request = URLRequest(url: url)
            request.setValue("PpApiMobile-iOS", forHTTPHeaderField: "User-Agent")
            task = created.downloadTask(with: request)
        }
        download = task
        task.resume()
    }

    private func retryOrFail(_ text: String) {
        busy = false
        download = nil
        speed = 0
        guard attempt < Self.maxAttempts else {
            fail(text + "（已重试 " + String(attempt) + " 次）")
            return
        }
        let delay = min(20.0, pow(2.0, Double(attempt - 1)))
        attempt += 1
        state = "downloading"
        message = text
        publish("downloading")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.state == "downloading" else { return }
            self.startTask()
        }
    }

    private func fileSize(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }

    // MARK: - URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        downloaded = totalBytesWritten
        if totalBytesExpectedToWrite > 0 { total = totalBytesExpectedToWrite }
        let now = Date()
        let elapsed = now.timeIntervalSince(lastTick)
        if elapsed >= 0.5 {
            speed = max(0, Int64(Double(totalBytesWritten - lastBytes) / elapsed))
            lastTick = now
            lastBytes = totalBytesWritten
        }
        if now.timeIntervalSince(lastPublish) >= 0.25 {
            lastPublish = now
            publish("downloading", tick: true)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard state == "downloading" else { return }
        if let response = downloadTask.response as? HTTPURLResponse, response.statusCode >= 400 {
            retryOrFail("服务器返回 " + String(response.statusCode))
            return
        }
        let manager = FileManager.default
        guard let base = manager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            fail("无法访问本地存储")
            return
        }
        let folder = base.appendingPathComponent("Updates", isDirectory: true)
        let target = folder.appendingPathComponent(Self.assetName)
        do {
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            if manager.fileExists(atPath: target.path) { try manager.removeItem(at: target) }
            try manager.moveItem(at: location, to: target)
        } catch {
            fail("安装包保存失败")
            return
        }
        busy = false
        download = nil
        resumeData = nil
        savedFile = target
        downloaded = fileSize(target)
        total = max(total, downloaded)
        speed = 0
        state = "ready"
        message = ""
        publish("ready")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard state == "downloading", let error = error else { return }
        if let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            resumeData = data
        }
        retryOrFail(error.localizedDescription)
    }
}
