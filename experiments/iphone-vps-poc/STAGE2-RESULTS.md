# Stage 2 — iPhone Mac-Off Feasibility (2026-11-01)

Scope: owner's own iPhone 12 running iOS 26.6.1, VPS Ubuntu 22.04, Tailscale over cellular 5G. Isolated PoC; no production/plugin route changes. No attendance clock-in/out submitted. No pairing records, signing keys, credentials, or tokens copied.

## Observed tests

| Test | Result | Evidence |
| --- | --- | --- |
| VPS to iPhone Tailscale peer while on cellular | PASS | TSMP ping, later direct path ~29 ms |
| Mac Xcode connected while USB plugged | PASS | `xcrun devicectl list devices` |
| Start WDA from Mac Appium, then reach WDA from VPS via Tailscale SOCKS5 | PASS | `GET /status` HTTP 200, `ready: true` |
| Stop Mac Appium, reach iPhone WDA from VPS | PASS | `GET /status` HTTP 200; Mac Appium loopback port not listening |
| Direct VPS screenshot via active WDA session | PASS | `GET /session/{id}/screenshot` HTTP 200, ~204 KB |
| Direct VPS activate Starbridges via active WDA session | PASS | `POST /session/{id}/wda/apps/activate` HTTP 200; **no attendance submitted** |
| Unplug USB and leave 5G + Tailscale | FAIL for WDA | `GET /status` over WDA port 8100 fails SOCKS5 CONNECT; repeated |
| VPS to iPhone after USB unplug | PASS | Tailscale reports online/direct; TSMP ping ~29 ms |
| VPS to iPhone Lockdown port 62078 | UNAVAILABLE | SOCKS5 CONNECT refused after USB unplug (also previously unavailable while USB plugged) |
| VPS to official Starbridges web login | PASS | Unauthenticated HTTPS GET returned 200 with valid TLS; authenticated attendance functionality **not verified** |

## What is established

The mobile-data VPN link is NOT the remaining blocker. A running WebDriverAgent is addressable over it and can execute real actions. However, direct WDA availability stops once the USB link is removed. This does not conclusively distinguish runner termination from interface/transport loss; both mean the user's required Mac/USB-off workflow currently fails.

Appium's non-macOS driver supports limited iOS 18+ sessions but needs host pairing/trust and a RemoteXPC tunnel. The official RemoteXPC library discovers iPhone/iPad via a USB or paired-and-enabled *local Wi-Fi* usbmuxd entry. Tailscale peer connectivity or the iOS Tailscale PeerAPI alone does not create a Lockdown/usbmuxd device on the VPS. Do not treat moving a pairing record as a solution to missing transport. Do not transfer private pairing identities without separate explicit owner approval.

## Decision candidates

1. **Starbridges official web portal (best next verification for attendance-specific goal)**: Official login page exists and VPS can reach it over HTTPS. Owner needs to authenticate through an approved flow and confirm whether web attendance/check-in is supported and authorized. No undocumented API assumptions, no forged geolocation/device evidence, no automatic consequential submit without owner confirmation.
2. **Official Starbridges integration (best long-term if vendor supports it)**: Ask employer/vendor for documented attendance API or App Intents/Shortcuts support. None located publicly; do not reverse engineer credentials or protected endpoints.
3. **Linux RemoteXPC investigation (research-only until real wireless-usbmux transport exists)**: To truly eliminate Mac/USB, establish a legitimate trusted iPhone transport over cellular that exposes Lockdown/CoreDeviceProxy to VPS. Official documentation only describes usbmuxd USB or paired local Wi-Fi iPhones. Do not claim solved. Installing Appium in VPS alone cannot bridge this gap.
4. **One-tap iPhone Shortcuts fallback**: Shortcut can open Starbridges and other explicitly exposed app actions, but iOS does not grant our companion app unrestricted cross-app tap/screenshot control. Owner may need to perform final attendance action in Starbridges.
5. **Always-on nearby host**: A local Mac or other paired host can control an iPhone that remains near it, but violates the requirement of a roaming 5G iPhone and no always-on Mac.

## Gate to production switch

Do not switch the personal iPhone Control MCP endpoint from its Mac relay until either (a) a real end-to-end Mac/USB-off WDA restart + control test passes, or (b) an authorized web/API attendance integration is end-to-end tested. Keep unrelated Remote MCP Arkan and shared VPS production routes unchanged.

## Primary documentation

- https://appium.github.io/appium-xcuitest-driver/12.11/guides/non-macos-hosts/
- https://appium.github.io/appium-xcuitest-driver/12.19/guides/remotexpc-tunnels-real-devices/
- https://github.com/appium/appium-ios-remotexpc/blob/main/README.md
- https://starbridges.indocyber.co.id/ (public login only)
- https://apps.apple.com/id/app/starbridges-mobile/id1458855866
