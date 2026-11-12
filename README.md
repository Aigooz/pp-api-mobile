# Pp API Mobile

Pp API 的第三方 Android 和 iOS 客户端。应用使用原生容器和共享移动界面，不代表 Pp API 官方。

## 功能

- 仪表盘、余额及用量分析，支持选择时间范围。
- 模型广场与渠道状态，令牌和多账号管理。
- 对话、历史记录、Markdown 和 LaTeX 公式渲染；Token 使用量为估算值，不代表实际计费。
- 充值、兑换、日卡和主题设置；具体功能与数据取决于服务端接口。
- Android 应用内检查和下载更新；iOS 提供未签名 IPA。

## 安装与更新

从 [GitHub Releases](https://github.com/Aigooz/pp-api-mobile/releases/latest) 下载：

- Android：`Pp-API-android.apk`。安装后可在「我的 → 软件更新」检查更新，系统会要求确认安装。
- iOS：`Pp-API-iOS-unsigned.ipa`。该文件不能直接安装，需使用自己的 Apple ID 等方式签名；设备要求 iOS 15 或更新版本。详见 [iOS 安装与构建说明](ios/README.md)。

旧版 Android 应用固定使用原更新仓库，迁移版本需要同时发布至旧更新仓库，供旧版升级；升级后从本仓库检查更新。iOS 旧版下载按钮仍会打开旧仓库，更新需重新签名。请勿删除旧仓库及迁移版本，否则旧版无法自动发现更新。

Android 更新器校验 Release 资产名称、版本、SHA-256、包名和签名。更新通知受系统调度和网络状态影响。

## 项目结构

- `app/src/main/assets/www/`：双端共享界面、业务逻辑和离线资源。
- `app/src/main/java/`：Android 容器和更新器。
- `ios/`：iOS 工程和原生桥接。
- `tests/`：界面、业务流程和更新验证。
- `.github/workflows/`：iOS 云端构建及模拟器检查。

## 本地开发与测试

需要 Node.js、npm，以及 Playwright 所需的浏览器：

```sh
npm ci
npx playwright install chromium webkit
npm run preview
npm test
```

真实服务只读测试需要自行设置 `PP_TEST_EMAIL` 和 `PP_TEST_PASSWORD` 后运行 `npm run test:live`；不要把凭据提交到仓库。模拟数据测试不需要真实账号。

## 构建与发布

Android 需要 JDK 17 或 21、Android SDK 35 和 Gradle 8.9。在配置 SDK 后运行 `gradle assembleRelease`，产物为 `app/build/outputs/apk/release/app-release.apk`。当前构建沿用本机 debug 签名以兼容已安装版本，密钥不在仓库中；更换密钥会导致无法覆盖安装，用户需卸载重装并可能丢失本地数据。正式分发应规划受保护的发布签名。

iOS 需要 macOS、Xcode 16 或更新版本；打开 `ios/PpApiMobile.xcodeproj`，或手动运行 `Build iOS package` 工作流。工作流生成未签名 IPA，并构建和启动模拟器。签名分发需要相应 Apple 开发者配置。

发布时递增 Android `versionCode`、`versionName` 与 iOS `CURRENT_PROJECT_VERSION`、`MARKETING_VERSION`，运行测试并检查签名。以 `v1.13.0` 等标签在本仓库创建正式 Release，上传 `Pp-API-android.apk` 和 `Pp-API-iOS-unsigned.ipa`；等待 GitHub 生成资产 SHA-256 后运行 `node tests/verify-release.mjs v1.13.0 <APK路径>`。迁移版本还须以相同文件名和内容发布到旧更新仓库，供旧版客户端升级。

## 数据与第三方组件

会话由 Android Keystore 或 iOS 钥匙串保护；浏览器预览不等同于原生安全存储。请勿提交账号、令牌、签名密钥或构建产物。随应用分发的第三方组件许可证位于 `app/src/main/assets/www/vendor/licenses/` 和 `app/src/main/assets/www/js/THIRD-PARTY-LICENSES.txt`。
