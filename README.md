# Pp API Mobile

Pp API 的第三方移动客户端，提供仪表盘、模型广场、令牌管理、多账号与对话。Android 和 iOS 共用 `app/src/main/assets/www` 中的界面。

## Android 安装与更新

从 [GitHub Releases](https://github.com/Aigooz/pp-api-mobile-updates/releases/latest) 下载 `Pp-API-android.apk` 并安装。首次安装带更新功能的版本需要手动安装，之后可在「我的 → 软件更新」检查、下载和安装更新。开启更新通知后，应用会定期检查新版本；检查时间会受 Android 系统调度和网络状态影响。

应用只接受公开更新仓库正式 Release 中指定名称的 APK，下载后验证 GitHub 提供的 SHA-256、包名、版本及与已安装应用相同的签名。安装由 Android 系统确认完成。

## 构建与发布

- Android 要求 JDK 17 或 21、Android SDK 35 和 Gradle 8.9。执行 `gradle assembleRelease` 构建 `app/build/outputs/apk/release/app-release.apk`。
- 当前测试版沿用最初安装包所用的本机 Android debug 签名，以支持覆盖安装。该密钥不在仓库中；丢失或更换密钥后，新包无法覆盖现有安装。正式分发前应迁移到妥善保管的专用发布密钥，这需要现有测试版用户卸载重装，并会清除应用本地数据。
- 发布更新时递增 `app/build.gradle` 中的 `versionCode` 和 `versionName`，继续使用相同签名；在公开更新仓库创建与版本一致的正式标签（如 `v1.2.0`），把 APK 作为 `Pp-API-android.apk` 上传到 GitHub Release。等待 GitHub 为资产生成 `sha256` 后再验证应用内检查。
- 执行 `npm ci` 和 `npm test` 运行界面与流程测试。

## iOS

iOS 工程位于 `ios/`。安装和更新需要 Mac、Xcode 和 Apple 签名，并通过 TestFlight、App Store 或其他适用的 Apple 分发方式提供。Android 的 GitHub APK 更新机制不能在 iOS 上安装应用，当前 iOS 尚未配置分发渠道。

## 说明

本客户端参考了 [phuketai-android](https://github.com/tf47683682/phuketai-android)，不代表 Pp API 官方。账号密码不存入仓库；本机保存的登录会话由 Android Keystore 或 iOS 钥匙串保护。
