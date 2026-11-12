# Pp API iOS

The iOS app wraps the shared mobile interface from `app/src/main/assets/www` in a native `WKWebView`. Its native bridge handles HTTPS API calls, streaming responses, clipboard access, haptics and external links.

## Windows 安装

本项目提供的是未签名的 IPA，不能直接在 iPhone 或 iPad 上点击安装。设备需要 iOS 15 或更新版本，可使用自己的 Apple ID 和 [Sideloadly](https://sideloadly.io/) 签名后安装：

1. 从 [GitHub 发布页面](https://github.com/Aigooz/pp-api-mobile/releases/latest) 下载 `Pp-API-iOS-unsigned.ipa`，并从 Sideloadly 官网下载 Windows 版。
2. 按 Sideloadly 官网提示安装 Apple 网站提供的 iTunes 和 iCloud。用 USB 连接设备，解锁并在设备上选择信任此电脑。
3. 启动 Sideloadly，选择设备，将 IPA 拖入窗口，输入自己的 Apple ID，点击 Start 并按照提示完成认证。
4. 如设备提示，前往「设置 → 通用 → VPN 与设备管理」信任开发者；iOS 16 及以上还可能需要在「设置 → 隐私与安全性 → 开发者模式」启用开发者模式并重启。

免费 Apple ID 的签名通常有效 7 天，到期后需重新签名安装；更新版本也需要重新签名。请只在签名工具中输入自己的 Apple ID 信息，不要发给项目维护者。

## Build with Xcode

1. On a Mac with Xcode 16 or newer, open `PpApiMobile.xcodeproj` and select the shared `PpApiMobile` scheme.
2. Keep the `ios` directory beside `app`; the Xcode build phase copies the shared web assets from that sibling directory.
3. For a connected iPhone or iPad, select the device and choose a development team under Signing & Capabilities. Change `com.ppapi.mobile` if that bundle identifier is already registered to another team, then build and run.
4. To distribute an installable IPA, create an Archive and export it with the appropriate Apple distribution signing method. TestFlight and App Store distribution require the corresponding Apple Developer account setup.

The deployment target is iOS 15. The GitHub Actions workflow builds an unsigned device IPA and checks the simulator build. A signed archive requires the appropriate Apple signing credentials.
