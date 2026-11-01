# ADR-002 — Realistic full iPhone UI control, 5G, Mac/USB-free (2026-11-01)

## Requirement

Owner wants ChatGPT in any supported conversation to open third-party iPhone apps, read their screens, tap, type, swipe/scroll feeds (e.g. TikTok), open YouTube and control Spotify, while target iPhone 12 roams on cellular 5G. Mac should not need to remain online, and no USB cable should remain connected.

The current Tailscale + VPS transport is proven. A WDA session initiated via a USB-linked Mac was remotely reachable and executable, but WDA became unreachable when USB was detached. This is NOT a working unattended architecture.

## Platform boundary

- iOS public App Intents and Shortcuts enable actions explicitly exposed by apps and system, **not arbitrary touch injection into unrelated apps**. A new native iPhone companion app cannot grant itself systemwide tap/swipe control.
- XCTest/WebDriverAgent is a developer testing mechanism. On iOS 18+ Linux needs paired/trusted device visibility via usbmuxd (USB or configured local wireless) and RemoteXPC. Tailscale application connectivity alone does not enumerate a trusted usbmuxd device.
- iPhone Mirroring works via a *nearby* Mac with Wi-Fi/Bluetooth and the same Apple Account; it is not a remote-WAN control protocol.
- Apple FaceTime offers real cross-app taps/swipes/keyboard for a trusted remote iPhone/iPad after the target owner accepts a screen-share/control request. It is session-based, requires another Apple device, and requires manual approval. It does NOT provide a documented ChatGPT/bot touch API.
- iOS supports assistive Bluetooth pointer devices; this suggests a separate Bluetooth HID input gateway might generate taps, but **automated control of an iPhone by a VPS through such a gateway is still unproven**. Reading the screen would require consented iOS screen sharing (ReplayKit on iOS 26; ScreenCaptureKit sample documentation currently says iOS 27+). Background lifetime and audio streaming are validation gates.

## Options

| Option | Generic TikTok swipe | Mac running? | USB on target? | Other equipment | Unattended? | Status |
|---|---|---|---|---|---|---|
| Native companion app + MCP + App Intents/API | No | No | No | No | Partially, app/system permissions permitting | Feasible subset |
| Mac Appium + WDA | Yes, tested | Yes | Yes in tested configuration | Mac | While connected | Existing PoC |
| Linux Appium + Tailscale only | No reliable channel | No | No | VPS | No | **Blocked**: no remote Lockdown/usbmux transport |
| Apple FaceTime remote-control session | Yes, Apple-supported between people | No | No | Second iPhone/iPad; for ChatGPT input an additional controller automation mechanism | No: owner must accept each session | **Best first manual full-UI demo** |
| Portable BLE HID + consented screen stream | Potentially | No | No | BLE-enabled controller device near target phone, with power and network; iOS capture app | Not proven | High-effort research path |
| Approved service integrations (e.g. Spotify playback API) | N/A, only supported action | No | No | OAuth/service grants | Depends | Useful independent features |
| Jailbreak/private iOS APIs | Possibly | No | No | Security and OS-version risks | Unreliable | Not recommended |

## Recommended stage gates

1. **Manual FaceTime proof**: owner uses iPhone 12 on 5G and a *second trusted iPhone/iPad* on a distinct internet link. Start one-to-one FaceTime, share target screen, request and Allow remote control, manually open a harmless app, swipe a feed, and type into a search field. Do NOT take attendance or make purchases.
2. If #1 passes and owner explicitly approves hardware: evaluate a BLE HID controller for the *controller* phone that can be driven from VPS, and verify remote input is correctly propagated over active FaceTime. Do not assume success.
3. Evaluate a consented display-capture path from the controller to VPS; preserve privacy, redact notifications, and require explicit session state/stop control.
4. Integrate only proven input/display transport with the existing private iPhone MCP gateway. Separate read-only and consequential actions; require confirmation for attendance/payment/messages.
5. Separately implement supported native app actions or approved service APIs (Spotify etc.) through OAuth, because these are more reliable than screen automation. Do not claim they cover TikTok scrolling.

## Hard acceptance test

From another ChatGPT room, while the target is on 5G with USB detached and Mac fully offline, issue harmless commands: read status, show screenshot, open YouTube, swipe TikTok feed, pause/play Spotify. Observe effects on target, recover from app/connection drops, and prove owner can stop access immediately. Do not publish or change production plugin endpoint before this passes.

## Sources

- https://support.apple.com/en-ke/guide/iphone/iph5d70f34a3/26/ios/26
- https://support.apple.com/id-id/120421
- https://support.apple.com/id-id/111775
- https://developer.apple.com/documentation/xcuiautomation
- https://appium.github.io/appium-xcuitest-driver/12.19/guides/remotexpc-tunnels-real-devices/
- https://github.com/appium/appium-ios-remotexpc/blob/main/README.md
- https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios
