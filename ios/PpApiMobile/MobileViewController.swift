import UIKit
import WebKit

final class MobileViewController: UIViewController, WKNavigationDelegate {
    private let bridge = NativeBridge()
    private let updater = UpdateManager()
    private var webView: WKWebView!
    private var statusBarStyle: UIStatusBarStyle = .darkContent
    private let statusBarGlass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    private let statusBarTint = UIView()
    private let statusBarEdge = CAGradientLayer()
    private let bottomGlass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    private let bottomTint = UIView()
    private let bottomEdge = CAGradientLayer()

    override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }
    override var prefersHomeIndicatorAutoHidden: Bool { false }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 14 / 255, green: 17 / 255, blue: 19 / 255, alpha: 1)
        bridge.viewController = self
        updater.onStatus = { [weak self] status, payload in self?.pushUpdate(status, payload) }
        updater.onTick = { [weak self] payload in self?.pushUpdateTick(payload) }
        updater.onExport = { [weak self] url in self?.presentUpdateFile(url) }
        let edgeBack = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgeBack(_:)))
        edgeBack.edges = .left
        edgeBack.maximumNumberOfTouches = 1
        edgeBack.cancelsTouchesInView = false
        view.addGestureRecognizer(edgeBack)

        let controller = WKUserContentController()
        controller.add(bridge, name: "ppNative")
        configureUserScripts(controller)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.isDirectionalLockEnabled = true
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        statusBarGlass.translatesAutoresizingMaskIntoConstraints = false
        statusBarGlass.isUserInteractionEnabled = false
        statusBarGlass.alpha = 0.46
        statusBarTint.translatesAutoresizingMaskIntoConstraints = false
        statusBarTint.isUserInteractionEnabled = false
        statusBarTint.backgroundColor = UIColor.clear
        statusBarEdge.colors = [UIColor.white.withAlphaComponent(0.20).cgColor, UIColor.white.withAlphaComponent(0.02).cgColor]
        statusBarEdge.startPoint = CGPoint(x: 0.5, y: 1)
        statusBarEdge.endPoint = CGPoint(x: 0.5, y: 0)
        view.addSubview(statusBarGlass)
        view.addSubview(statusBarTint)
        bottomGlass.translatesAutoresizingMaskIntoConstraints = false
        bottomGlass.isUserInteractionEnabled = false
        bottomGlass.alpha = 0.42
        bottomTint.translatesAutoresizingMaskIntoConstraints = false
        bottomTint.isUserInteractionEnabled = false
        bottomTint.backgroundColor = UIColor.clear
        bottomEdge.colors = [UIColor.white.withAlphaComponent(0.02).cgColor, UIColor.white.withAlphaComponent(0.20).cgColor]
        bottomEdge.startPoint = CGPoint(x: 0.5, y: 0)
        bottomEdge.endPoint = CGPoint(x: 0.5, y: 1)
        view.addSubview(bottomGlass)
        view.addSubview(bottomTint)
        statusBarTint.layer.addSublayer(statusBarEdge)
        bottomTint.layer.addSublayer(bottomEdge)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            statusBarGlass.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            statusBarGlass.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            statusBarGlass.topAnchor.constraint(equalTo: view.topAnchor),
            statusBarGlass.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            statusBarTint.leadingAnchor.constraint(equalTo: statusBarGlass.leadingAnchor),
            statusBarTint.trailingAnchor.constraint(equalTo: statusBarGlass.trailingAnchor),
            statusBarTint.topAnchor.constraint(equalTo: statusBarGlass.topAnchor),
            statusBarTint.bottomAnchor.constraint(equalTo: statusBarGlass.bottomAnchor),
            bottomGlass.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomGlass.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomGlass.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            bottomGlass.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bottomTint.leadingAnchor.constraint(equalTo: bottomGlass.leadingAnchor),
            bottomTint.trailingAnchor.constraint(equalTo: bottomGlass.trailingAnchor),
            bottomTint.topAnchor.constraint(equalTo: bottomGlass.topAnchor),
            bottomTint.bottomAnchor.constraint(equalTo: bottomGlass.bottomAnchor)
        ])

        bridge.webView = webView
        guard let www = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true),
              let entry = Bundle.main.resourceURL?.appendingPathComponent("www/index.html") else {
            showLoadError()
            return
        }
        webView.loadFileURL(entry, allowingReadAccessTo: www)
    }

    @objc private func handleEdgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
        if gesture.state == .ended {
            webView.evaluateJavaScript("window.__ppBack && window.__ppBack()")
        }
    }

    func refreshSecureScripts() {
        guard let controller = webView?.configuration.userContentController else { return }
        configureUserScripts(controller)
    }

    // MARK: - In-app updater

    func handleUpdate(_ action: String) {
        switch action {
        case "updateCheck": updater.check()
        case "updateDownload": updater.startDownload()
        case "updateInstall": updater.install()
        case "updateResume": updater.resume()
        case "updateCancel": updater.cancel()
        default: break
        }
    }

    private func pushUpdate(_ status: String, _ payload: [String: Any]) {
        guard let raw = Self.jsonString(payload), let stateArg = Self.jsonString(status) else { return }
        updaterSnapshot = updater.snapshot()
        run("window.__ppUpdateSnapshot = \(updaterSnapshot); window.__nativeUpdate && window.__nativeUpdate(\(stateArg), \(raw));")
    }

    private func pushUpdateTick(_ payload: [String: Any]) {
        guard let raw = Self.jsonString(payload) else { return }
        updaterSnapshot = updater.snapshot()
        run("window.__ppUpdateSnapshot = \(updaterSnapshot); window.__ppUpdateTick && window.__ppUpdateTick(\(raw));")
    }

    private var updaterSnapshot = "{}"

    private func presentUpdateFile(_ url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 60, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }

    private func run(_ script: String) {
        DispatchQueue.main.async { [weak self] in self?.webView?.evaluateJavaScript(script) }
    }

    private static func jsonString(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func configureUserScripts(_ controller: WKUserContentController) {
        controller.removeAllUserScripts()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let versionJSON = (try? JSONSerialization.data(withJSONObject: [version]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        controller.addUserScript(WKUserScript(
            source: "window.__ppSecureInitial = \(NativeBridge.secureInitialJSON()); window.__ppVersion = \(versionJSON)[0];",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: Self.nativeShim,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // WKWebView ignores the page's user-scalable flag on some iOS versions; pin the
        // viewport hard so a two-finger gesture can never zoom this native shell.
        controller.addUserScript(WKUserScript(
            source: """
            (function () {
              var lock = function () {
                var meta = document.querySelector('meta[name=viewport]');
                if (!meta) { meta = document.createElement('meta'); meta.name = 'viewport'; (document.head || document.documentElement).appendChild(meta); }
                meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover');
              };
              lock();
              document.addEventListener('DOMContentLoaded', lock);
              ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (name) {
                document.addEventListener(name, function (e) { e.preventDefault(); }, { passive: false });
              });
              document.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyInsets()
        statusBarEdge.frame = statusBarTint.bounds
        bottomEdge.frame = bottomTint.bounds
    }

    func setStatusBarStyle(dark: Bool) {
        statusBarStyle = dark ? .darkContent : .lightContent
        setNeedsStatusBarAppearanceUpdate()
    }

    func setStatusBarColor(_ color: UIColor?) {
        UIView.animate(withDuration: 0.28, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.statusBarTint.backgroundColor = color?.withAlphaComponent(0.08)
            self.statusBarGlass.alpha = color == nil ? 0.34 : 0.48
            self.bottomTint.backgroundColor = color?.withAlphaComponent(0.06)
            self.bottomGlass.alpha = color == nil ? 0.32 : 0.44
        }
    }

    func openExternal(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return }
        UIApplication.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.isFileURL, let root = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true),
           url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/") {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated {
            openExternal(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        applyInsets()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError()
    }

    private func applyInsets() {
        let top = view.safeAreaInsets.top
        let bottom = view.safeAreaInsets.bottom
        webView?.evaluateJavaScript("window.__applyInsets && window.__applyInsets(\(top),\(bottom))")
    }

    private func showLoadError() {
        guard isViewLoaded else { return }
        let label = UILabel()
        label.text = "客户端资源暂不可用，请重新安装应用。"
        label.textColor = .secondaryLabel
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    private static let nativeShim = #"""
    (() => {
      const send = message => window.webkit.messageHandlers.ppNative.postMessage(message);
      window.Native = Object.freeze({
        http: (id, method, url, headers, body) => send({ action: 'http', id, method, url, headers, body }),
        stream: (id, method, url, headers, body) => send({ action: 'stream', id, method, url, headers, body }),
        abort: id => send({ action: 'abort', id }),
        toast: () => {},
        copy: text => send({ action: 'copy', text: String(text) }),
        open: url => send({ action: 'open', url: String(url) }),
        vibrate: milliseconds => send({ action: 'vibrate', milliseconds }),
        device: () => JSON.stringify({ model: 'iPhone', brand: 'Apple', release: navigator.userAgent, app: window.__ppVersion, platform: 'ios' }),
        statusBar: (color, darkIcons) => send({ action: 'statusBar', color, darkIcons }),
        keepAwake: on => send({ action: 'keepAwake', on }),
          back: () => send({ action: 'back' }),
          updateCheck: () => send({ action: 'updateCheck' }),
          updateDownload: () => send({ action: 'updateDownload' }),
          updateInstall: () => send({ action: 'updateInstall' }),
          updateResume: () => send({ action: 'updateResume' }),
          updateCancel: () => send({ action: 'updateCancel' }),
          updateProgress: () => window.__ppUpdateSnapshot || '{}',
          updateNotificationState: () => 'disabled',
          updateEnableNotifications: () => {},
        secureMode: () => 'async',
        secureGet: () => { const value = window.__ppSecureInitial; delete window.__ppSecureInitial; return value; },
        secureSet: (id, value) => send({ action: 'secureSet', id, value })
      });
    })();
    """#
}
