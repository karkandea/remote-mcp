# ADR-001 — iPhone Control, VPS-first

**Decision:** Adopted for the feasibility PoC, 2026-11-01. **Production migration: not authorized.**

## Responsibilities

| Component | Responsibility | Boundary |
| --- | --- | --- |
| iPhone Control MCP | ChatGPT-facing owner-authorized iPhone tools | Separate from Remote MCP Arkan's general Mac/VPS administration |
| VPS Controller | OAuth, per-device allowlists, dispatch, bounded audit and reconnect | Always-on control plane; no public Appium/WDA port |
| Official integration adapter | Invoke documented/approved app APIs | Preferred for Starbridges attendance if the employer permits it |
| iPhone Agent / Shortcut | Handle only supported iOS App Intents, deep links and user interaction | Cannot tap or inspect arbitrary third-party app screens |
| Appium Linux adapter | Experimental XCUITest UI automation with preinstalled signed WDA | Requires trusted pairing and working RemoteXPC; no production claim |
| Remote MCP Arkan | Existing Mac/VPS operations and legacy fallback | No implicit iPhone admin access via the iPhone-only tool surface |

## Stage gates

1. **Network feasibility only:** Enroll the iPhone and an isolated VPS client in a private Tailscale tailnet. With Mac offline and iPhone on cellular, prove both peers see each other. This **does not** prove usbmuxd, Lockdown or RemoteXPC works. Do not migrate credentials or install Appium yet.
2. **Device protocol feasibility:** Determine whether Linux can establish a trusted Lockdown/RemoteXPC session across the tailnet. Stop if the service relies on LAN-only discovery or pairing that cannot be completed safely. Any export of existing Mac pairing material needs a **separate explicit owner approval** and a secure handling plan.
3. **Isolated Appium:** Only after stage 2 succeeds and VPS disk headroom is approved, pin an XCUITest driver compatible with Linux and Node 22. Use `appium:usePreinstalledWDA` and bound loopback, not `xcodebuild` on the VPS. Keep kernel/host networking and production Nginx/systemd unchanged until reviewed.
4. **No-Mac hardware test:** Mac powered off, iPhone cellular + VPN. Test screenshot, accessibility tree, open allowlisted Starbridges app, safe tap/swipe and teardown. No real Clock In/Out, location spoofing, or saved credentials in debug logs.
5. **Reliability and release:** Confirm three separate sessions, reconnect after network loss, correct OAuth subject, deny unapproved bundle IDs, and no admin/root tools in iPhone discovery. Only then migrate the existing personal iPhone Control plugin to the new endpoint with rollback.

## Fail-closed criteria

- If Stage 1 succeeds but RemoteXPC cannot traverse the cellular VPN, report *VPS-only UI automation unproven* and stop infrastructure changes.
- If official Starbridges integration is unavailable or not authorized, do not simulate attendance submissions through undocumented endpoints.
- Never publish TCP 4723, WDA 8100, or the RemoteXPC tunnel registry to the open internet.
- Do not run a background iOS agent under a claim of unrestricted cross-app control.

## Existing facts

- iPhone 12 on iOS 26.6.1 has been exercised via Mac-hosted Appium and signed WDA; **not** yet from Linux.
- VPS is Ubuntu, Node.js 22, has `/dev/net/tun` and `usbmuxd`, but lacks Appium, a trusted device record and a private iPhone tunnel. Disk was 90% utilized with ~6.5 GiB available at preflight.
- Existing personal iPhone Control plugin v0.2.0 is still routed through the Mac-side adapter. Keep it as fallback during PoC.

## References

- Appium non-macOS requirements: https://appium.github.io/appium-xcuitest-driver/12.11/guides/non-macos-hosts/
- Appium RemoteXPC tunnel requirements: https://appium.github.io/appium-xcuitest-driver/12.11/guides/remotexpc-tunnels-real-devices/
- Tailscale iOS client: https://tailscale.com/docs/install/ios
- Tailscale Linux client: https://tailscale.com/docs/install/linux
