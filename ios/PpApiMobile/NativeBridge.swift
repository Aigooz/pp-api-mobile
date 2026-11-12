import Foundation
import Security
import UIKit
import WebKit

private final class NativeRequest {
    let id: String
    let isStream: Bool
    var response: HTTPURLResponse?
    var body = Data()
    var lineBuffer = Data()

    init(id: String, isStream: Bool) {
        self.id = id
        self.isStream = isStream
    }
}

final class NativeBridge: NSObject, WKScriptMessageHandler, URLSessionDataDelegate, URLSessionTaskDelegate {
    private static let secureService = "com.ppapi.mobile.auth"
    private static let secureAccount = "auth-vault-v1"
    weak var webView: WKWebView?
    weak var viewController: MobileViewController?

    private let queue = OperationQueue()
    private let stateLock = NSLock()
    private var session: URLSession!
    private var requests: [Int: NativeRequest] = [:]
    private var tasksByID: [String: URLSessionDataTask] = [:]

    override init() {
        super.init()
        queue.name = "com.ppapi.mobile.network"
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .default, delegate: self, delegateQueue: queue)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        switch action {
        case "http", "stream": startRequest(body, isStream: action == "stream")
        case "secureSet":
            if let id = body["id"] as? String, let value = body["value"] as? String {
                let saved = Self.secureWrite(value)
                if saved { viewController?.refreshSecureScripts() }
                evaluate("window.__nativeSecure", [id, saved])
            }
        case "abort": abort(body["id"] as? String)
        case "copy":
            if let text = body["text"] as? String { DispatchQueue.main.async { UIPasteboard.general.string = text } }
        case "open":
            if let raw = body["url"] as? String, let url = URL(string: raw) {
                DispatchQueue.main.async { self.viewController?.openExternal(url) }
            }
        case "vibrate":
            DispatchQueue.main.async {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        case "statusBar":
            if let dark = body["darkIcons"] as? Bool {
                let raw = body["color"] as? String
                DispatchQueue.main.async {
                    self.viewController?.setStatusBarStyle(dark: dark)
                    if let raw, let color = Self.color(raw) { self.viewController?.setStatusBarColor(color) }
                    else { self.viewController?.setStatusBarColor(nil) }
                }
            }
        case "keepAwake":
            if let on = body["on"] as? Bool {
                DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
            }
        default: break
        }
    }

    private static func secureQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: secureService,
            kSecAttrAccount as String: secureAccount
        ]
    }

    static func secureInitialJSON() -> String {
        var query = secureQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        let value: Any
        if status == errSecItemNotFound {
            value = ""
        } else if status == errSecSuccess, let data = result as? Data,
                  let string = String(data: data, encoding: .utf8) {
            value = string
        } else {
            value = NSNull()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let json = String(data: data, encoding: .utf8) else { return "null" }
        return String(json.dropFirst().dropLast())
    }

    private static func secureWrite(_ value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }
        let query = secureQuery()
        let updates: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, updates as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        if let url = request.url, Self.isAllowed(url) {
            completionHandler(request)
        } else {
            completionHandler(nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let state = requestState(for: dataTask.taskIdentifier) {
            state.response = response as? HTTPURLResponse
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let state = requestState(for: dataTask.taskIdentifier) else { return }
        if state.isStream, let status = state.response?.statusCode, status < 400 {
            consumeStreamData(data, state: state)
        } else {
            state.body.append(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        stateLock.lock()
        let state = requests.removeValue(forKey: task.taskIdentifier)
        if let state { tasksByID.removeValue(forKey: state.id) }
        stateLock.unlock()
        guard let state else { return }
        let status = state.response?.statusCode ?? 0
        let headers = headerJSON(state.response)

        if state.isStream {
            flushStreamBuffer(state)
            let failure: String?
            if let error {
                failure = error.localizedDescription
            } else if status >= 400 {
                failure = String(data: state.body, encoding: .utf8) ?? "HTTP \(status)"
            } else {
                failure = nil
            }
            evaluate("window.__nativeEnd", [state.id, failure as Any? ?? NSNull(), status])
        } else if let error {
            let errorHeaders = (try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            evaluate("window.__nativeHttp", [state.id, 0, "", errorHeaders])
        } else {
            let text = String(data: state.body, encoding: .utf8) ?? ""
            evaluate("window.__nativeHttp", [state.id, status, Data(text.utf8).base64EncodedString(), headers])
        }
    }

    private func startRequest(_ body: [String: Any], isStream: Bool) {
        guard let id = body["id"] as? String,
              let method = body["method"] as? String,
              let rawURL = body["url"] as? String,
              let url = URL(string: rawURL), Self.isAllowed(url),
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method.uppercased()),
              (url.path != "/api/public/channel-status" || method.uppercased() == "GET"),
              (url.path != "/api/daycard/info" || method.uppercased() == "GET"),
              (url.path != "/api/daycard/buy" || method.uppercased() == "POST") else {
            fail(body["id"] as? String, isStream: isStream, message: "不支持的网络请求")
            return
        }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: isStream ? 300 : 120)
        request.httpMethod = method.uppercased()
        if let rawHeaders = body["headers"] as? String,
           let data = rawHeaders.data(using: .utf8),
           let headers = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            for (name, value) in headers where !["host", "content-length", "connection"].contains(name.lowercased()) {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        if let payload = body["body"] as? String, !payload.isEmpty,
           !["GET", "DELETE"].contains(method.uppercased()) {
            request.httpBody = Data(payload.utf8)
        }

        let state = NativeRequest(id: id, isStream: isStream)
        let task = session.dataTask(with: request)
        stateLock.lock()
        requests[task.taskIdentifier] = state
        tasksByID[id] = task
        stateLock.unlock()
        task.resume()
    }

    private func abort(_ id: String?) {
        guard let id else { return }
        stateLock.lock()
        let task = tasksByID.removeValue(forKey: id)
        if let task { requests.removeValue(forKey: task.taskIdentifier) }
        stateLock.unlock()
        task?.cancel()
    }

    private func requestState(for taskID: Int) -> NativeRequest? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return requests[taskID]
    }

    private func consumeStreamData(_ data: Data, state: NativeRequest) {
        state.lineBuffer.append(data)
        while let newline = state.lineBuffer.firstIndex(of: 10) {
            var line = Data(state.lineBuffer[..<newline])
            state.lineBuffer.removeSubrange(...newline)
            if line.last == 13 { line.removeLast() }
            sendStreamLine(line, id: state.id)
        }
    }

    private func flushStreamBuffer(_ state: NativeRequest) {
        guard !state.lineBuffer.isEmpty else { return }
        var line = state.lineBuffer
        if line.last == 13 { line.removeLast() }
        state.lineBuffer.removeAll(keepingCapacity: false)
        sendStreamLine(line, id: state.id)
    }

    private func sendStreamLine(_ data: Data, id: String) {
        evaluate("window.__nativeChunk", [id, data.base64EncodedString()])
    }

    private func fail(_ id: String?, isStream: Bool, message: String) {
        guard let id else { return }
        if isStream {
            evaluate("window.__nativeEnd", [id, message, 0])
        } else {
            let headers = (try? JSONSerialization.data(withJSONObject: ["error": message]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            evaluate("window.__nativeHttp", [id, 0, "", headers])
        }
    }

    private func headerJSON(_ response: HTTPURLResponse?) -> String {
        let headers = Dictionary(uniqueKeysWithValues: (response?.allHeaderFields ?? [:]).compactMap { key, value -> (String, String)? in
            guard let key = key as? String else { return nil }
            return (key.lowercased(), String(describing: value))
        })
        guard let data = try? JSONSerialization.data(withJSONObject: headers),
              let value = String(data: data, encoding: .utf8) else { return "{}" }
        return value
    }

    private func evaluate(_ function: String, _ arguments: [Any]) {
        guard JSONSerialization.isValidJSONObject(arguments),
              let data = try? JSONSerialization.data(withJSONObject: arguments, options: [.fragmentsAllowed]),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("\(function).apply(window, \(json))")
        }
    }

    private static func isAllowed(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased() else { return false }
        if host == "ipkey.vip" {
            return url.path.hasPrefix("/api/v1/") || url.path == "/api/public/channel-status"
                || url.path == "/api/daycard/info" || url.path == "/api/daycard/buy"
        }
        if host == "api.ipkey.vip" { return url.path.hasPrefix("/v1/") }
        return false
    }

    private static func color(_ raw: String) -> UIColor? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6 || value.count == 8, let number = UInt64(value, radix: 16) else { return nil }
        let hasAlpha = value.count == 8
        let red = CGFloat((number >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let green = CGFloat((number >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let blue = CGFloat((number >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let alpha = hasAlpha ? CGFloat(number & 0xff) / 255 : 1
        return UIColor(red: red, green: green, blue: blue, alpha: alpha)
    }
}
