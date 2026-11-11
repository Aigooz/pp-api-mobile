# Pp API iOS

The iOS app wraps the shared mobile interface from `app/src/main/assets/www` in a native `WKWebView`. Its native bridge handles HTTPS API calls, streaming responses, clipboard access, haptics and external links.

## Build and install

1. On a Mac with Xcode 16 or newer, open `PpApiMobile.xcodeproj` and select the shared `PpApiMobile` scheme.
2. Keep the `ios` directory beside `app`; the Xcode build phase copies the shared web assets from that sibling directory.
3. For a connected iPhone or iPad, select the device and choose a development team under Signing & Capabilities. Change `com.ppapi.mobile` if that bundle identifier is already registered to another team, then build and run.
4. To distribute an installable IPA, create an Archive and export it with the appropriate Apple distribution signing method. TestFlight and App Store distribution require the corresponding Apple Developer account setup.

The deployment target is iOS 15. The Xcode project and source assets are included here, but an IPA cannot be signed or installed directly from this Windows workspace because Apple's build and signing tools are only available on macOS.
