# Stage 1 result — 5G iPhone ↔ VPS tailnet

Date: 2026-11-01 (Asia/Jakarta)

**Result: encrypted peer connectivity and iPhone TCP host access PASS; RemoteXPC/WDA NOT YET PROVEN.**

## Tests

| Check | Result | Meaning |
| --- | --- | --- |
| Tailscale userspace daemon on VPS | PASS, version 1.104.4 | Binaries isolated in `/opt/iphone-vps-poc/tailscale`; local SOCKS5 at 127.0.0.1:1055 |
| iPhone online in same tailnet | PASS | Verified after owner reported iPhone Wi-Fi off, 5G and VPN on |
| Tailscale TSMP over WireGuard | PASS, ~363 ms | Encrypted overlay reaches the iPhone through DERP fallback; direct peer path not proven |
| iPhone Tailscale PeerAPI via SOCKS5 | PASS, HTTP 200 | Confirms TCP application connectivity from VPS to an iPhone-hosted service |
| WebDriverAgent TCP/8100 via SOCKS5 | NOT AVAILABLE, SOCKS reply 1 | WDA was not known to be running; cannot infer general incompatibility |
| Apple Lockdown TCP/62078 via SOCKS5 | NOT AVAILABLE, SOCKS reply 1 | Linux VPS is unpaired; no RemoteXPC session attempted |
| Remote MCP relay and Nginx | Both active | Existing production services retained their state |
| VPS default route and host Tailscale interface | Unchanged; no `tailscale0` | Userspace mode did not alter host DNS/default routing |

## Security and next gate

- No Mac device pairing records, WDA signing credentials, tokens or certificates were exported.
- No Appium Linux installation, system-wide Tailscale package, production MCP plugin update, or Nginx reload occurred in this stage.
- A successful PeerAPI TCP test **does not** prove Apple's usbmuxd/Lockdown/RemoteXPC services work across a 5G VPN.
- Stage 2 requires a decision on secure pairing. Copying trust material from the Mac to an internet-facing VPS is a sensitive security change and **requires separate owner authorization**; do not do it as part of routine network diagnostics.
- Continue to prefer an approved Starbridges API for consequential attendance actions. Never spoof attendance location or submit Clock In/Out in hardware smoke tests.
