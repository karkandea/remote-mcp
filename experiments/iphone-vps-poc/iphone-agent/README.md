# iPhone Agent (single-device, software-only PoC)

Target: owner's iPhone 12 on cellular 5G, without a Mac/USB in **runtime**.

**Status as of 2026-11-01:** Gateway unit/integration tests pass (6/6). The SwiftUI app compiles for iOS Simulator; physical-device signing, push notification delivery and iOS Shortcuts automation still need end-to-end validation. **Not production-ready or full iPhone UI control.**

## Control flow

1. Authorized ChatGPT MCP tool submits a *predefined safe action* to the VPS gateway.
2. Gateway queues it for up to 90 seconds and sends an APNs alert to the paired iPhone.
3. The owner's iOS 26 Shortcuts notification automation invokes the app's `Fetch Remote Command` App Intent.
4. The Shortcut maps that result to Apple's supported `Open App` / `Play/Pause` actions.

This approach does **not** tap or swipe other native apps, silently screenshot them, bypass iOS prompts or guarantee an app will open while the phone is locked. Any apparent execution result must be labeled `queued_not_executed` until confirmed on-device.

## Supported command vocabulary

`open_youtube`, `open_tiktok`, `open_spotify`, `open_starbridges`, `media_play_pause`.

No arbitrary app bundle ID, raw URL, shell command, coordinate tap, credential entry, or attendance submission is accepted by the gateway. Spotify's own playback API may be a better independent route after explicit user OAuth.

## Backend

Node.js 20+; zero runtime dependencies. Binds `127.0.0.1:4877` by default; use a dedicated HTTPS reverse-proxy route with rate limits, no public exposure to localhost. Persistent device state is encrypted using AES-256-GCM and stored with mode `0600`.

Configuration (provide as runtime secrets; **never commit actual values**):

| Variable | Purpose |
| --- | --- |
| `IPHONE_AGENT_STATE_FILE` | Absolute path to encrypted state |
| `IPHONE_AGENT_STATE_KEY` | 32 cryptographically random bytes in base64url form |
| `IPHONE_AGENT_ADMIN_TOKEN` | 32+ character admin secret; belongs in private MCP server configuration |
| `IPHONE_AGENT_PAIR_CODE` | Temporary **8-digit** code; valid for 10 minutes after gateway start, max 5 wrong tries |
| `IPHONE_AGENT_PORT` | Optional port (default `4877`) |
| `APNS_KEY_ID`, `APNS_TEAM_ID` | Apple Developer APNs identifiers |
| `APNS_TOPIC` | Application bundle ID (`com.karkandea.iphoneagent`) |
| `APNS_KEY_PATH` | Private Apple APNs `.p8` file stored only on VPS, outside repo |
| `APNS_ENVIRONMENT` | `sandbox` for debug app, `production` for production signing |

Run tests: `cd backend && npm test`.

For temporary manual-only testing without APNs set `IPHONE_AGENT_MANUAL_MODE=1`. This lets the paired iPhone fetch queued commands when the user explicitly runs its Shortcut, **but does not notify or automatically execute**.

### HTTP API (under a future reverse proxy prefix `/iphone-agent`)

- `GET /health/live` — public minimal liveness, no user data
- `POST /v1/enroll` — one-time pairing code; returns device secret only to phone
- `POST /v1/device/push-token` — device bearer; registers APNs token
- `GET /v1/device/status` — device bearer; returns push registration status
- `POST /v1/device/next` — device bearer; atomically takes at most one pending command
- `POST /v1/admin/commands` — admin bearer; `{ "action": "open_youtube" }`

All authenticated endpoints require `Authorization: Bearer <secret>`. No real attendance actions exist.

## iPhone app

SwiftUI project generated with XcodeGen (`ios/project.yml`); deployment target iOS 26.0. Simple screen: pair → enable notifications → send a local test notification → configure Shortcuts. Device secret is held in iOS Keychain with `AfterFirstUnlockThisDeviceOnly` accessibility.

Mac build commands, for *build time only*:

```bash
xcodegen generate --spec ios/project.yml --project ios
xcodebuild -project ios/iPhoneAgent.xcodeproj -scheme iPhoneAgent -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

To install on the personal iPhone, a temporary paired Xcode connection and signing entitlement for **Push Notifications** are needed. This app has **not** been installed yet; never claim it is controlling the device.

## Shortcuts automation — owner configuration required

After installing the app and granting notifications:

1. Open **Shortcuts → Automation → Notification** and select **iPhone Agent** as the source (iOS 26).
2. Choose the least-interactive execution mode the system allows; the owner must approve any prompted permissions.
3. Add the app action **Fetch Remote Command**.
4. Add explicit `If` branches on its returned string, e.g. `open_youtube` → **Open App: YouTube**, `open_tiktok` → **Open App: TikTok** and `media_play_pause` → **Play/Pause**. Do not add arbitrary scripts or automatic attendance.
5. Test with the app's **Send Test Notification** and a harmless `open_youtube` command. Check on-device behavior when app is foreground, background, and locked separately.

The notification trigger is documented by Apple's WWDC26 but still needs empirical validation on this exact iPhone/iOS version. The app's local test notification does not depend on APNs; remote commands do.

## Security / production gates

- No APNs signing private key, OAuth token, device secret or pairing record in source control or ChatGPT logs.
- Keep VPS gateway isolated and loopback-only until device+APNs+Shortcuts tests pass; existing `/iphone/mcp` Mac relay remains unchanged.
- Device can revoke access by uninstalling the app or disabling its notifications; add server-side revoke UI before production.
- Confirmation for consequential actions such as HR attendance, purchases and messages is mandatory; those actions are **not implemented** in this PoC.
- iOS has no public API for an app to inject arbitrary taps/swipes into TikTok/YouTube/Starbridges. This PoC is a bounded fallback, **not Full iPhone Control**.

Official Apple notification automation overview: https://developer.apple.com/videos/play/wwdc2026/310/
