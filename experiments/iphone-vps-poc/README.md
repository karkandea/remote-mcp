# iPhone Control — VPS-only feasibility PoC

Isolated experiment for `karkandea/remote-mcp`. **Not a production backend** and not a way to bypass iOS security or workplace attendance rules.

## Target

ChatGPT → existing owner-OAuth iPhone Control MCP → VPS Appium/XCUITest → trusted iPhone over an authenticated private tunnel. The Mac must be **off during the acceptance test**.

Appium XCUITest Driver's documented non-macOS mode supports real iOS 18+ devices with a preinstalled signed WebDriverAgent and RemoteXPC tunnel. It does **not** mean a phone on arbitrary cellular internet can already be reached.

Docs: https://appium.github.io/appium-xcuitest-driver/12.11/guides/non-macos-hosts/ and https://appium.github.io/appium-xcuitest-driver/12.11/guides/remotexpc-tunnels-real-devices/

## Safe preflight

Run `npm test` and `npm run preflight`. No dependencies are installed by these commands. An exit code of 2 means prerequisites are missing, not that the iPhone failed automation. The probe does not read pairing secrets or contact private services.

## Required gates before installing Appium

1. **Owner consent** for any iPhone pairing-material migration: never export an existing Mac lockdown key, certificate, or signing identity without explicit permission and a secure transfer plan.
2. **Network design**: prove an outbound-initiated encrypted device-to-VPS tunnel with no public WDA/RemoteXPC/port 8100 exposure. A VPN address alone does not prove usbmuxd/Lockdown discovery works.
3. **Storage**: confirm adequate disk headroom on the shared VPS. Do not install system packages, alter existing `remote-mcp-relay`, or reload Nginx for this PoC.
4. **Driver**: only in a separate directory, pin Appium and XCUITest Driver versions compatible with Node 22. Run `appium driver doctor xcuitest` after installing; do not create root TUN services without approval.
5. **Device**: use an explicitly approved UDID and signed WDA bundle ID with `appium:usePreinstalledWDA`; keep Appium bound to `127.0.0.1` and inspect `/status` first.

## Acceptance test (no Clock In/Out)

- Mac is powered off and the iPhone uses cellular data plus the private tunnel.
- VPS can establish RemoteXPC and start three independent sessions without a Mac.
- Read a Starbridges accessibility tree and screenshot; open the allowlisted app but **do not submit attendance**.
- Terminate the session, kill the tunnel, and confirm the MCP fails closed. Reconnect automatically and repeat.
- No raw credentials, session IDs, WDA endpoints, or pairing records are logged or committed.

If pairing or the private-tunnel transport cannot work remotely, stop this branch and prefer an **authorized Starbridges attendance API** over UI automation. A normal iPhone companion app cannot tap arbitrary other iOS apps.
