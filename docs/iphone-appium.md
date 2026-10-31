# iPhone controls through Remote MCP Arkan (owner opt-in)

This feature runs **only on the Mac**, using the owner's already-installed, localhost-only Appium/XCUITest server. ChatGPT connects to the existing HTTPS VPS relay and OAuth owner token, then uses the authenticated Mac WebSocket channel. There is **no OpenAI Platform API, tunnel, GitHub Actions, generic shell command, or public Appium port** involved.

## What gets exposed

Ten additional MCP tools:

| Tool | Operation |
| --- | --- |
| `iphone_status` | Check localhost Appium readiness and session state |
| `iphone_appium_server_start` | Spawn the **exact local executable** configured by the owner; fixed bind `127.0.0.1` and port |
| `iphone_appium_server_stop` | Stop only the Appium process this Mac agent started |
| `iphone_session_start` | Initiate an XCUITest session asynchronously using the owner's configured UDID and signing metadata |
| `iphone_session_stop` | End the current session |
| `iphone_ui_tree` | Read up to 35,000 characters of on-screen accessibility XML |
| `iphone_screenshot` | Return a bounded screenshot image, downscaled with macOS `sips` when needed |
| `iphone_tap` | Touch a bounded screen coordinate |
| `iphone_swipe` | Swipe between bounded screen coordinates |
| `iphone_app_open` | Activate only a bundle ID in `iphoneControl.allowedBundleIds` |

All Mac tools require the owner's active device access. The Appium URL is always `http://127.0.0.1:<local-port>`; callers cannot change endpoint paths, XCUITest session capabilities, device UDID, or command-line arguments. Appium may show sensitive screen content. Do **not** use this with untrusted users or for sensitive actions without review.

## One-time setup on the Mac

Prerequisites: iPhone connected/unlocked/trusted; Xcode developer signing and WebDriverAgent prepared; the project has Appium and the XCUITest driver installed. Appium itself must never be exposed publicly or started with `--relaxed-security`.

1. Ensure the iPhone project has `session-request.json` with `capabilities.alwaysMatch['appium:udid']` (or an equivalent `desiredCapabilities.udid`). Optionally include the exact `appium:bundleId` you permit. Never guess a bundle ID. Review the file locally before enabling access.
2. Using the checked-out updated Remote MCP Arkan repository, run **locally**:

   ```sh
   node scripts/setup-iphone-appium.mjs /Users/arkan/Projects/iphone-control-poc
   ```

   The script creates `~/.config/remote-mcp/config.json.before-iphone-control` once, updates only `iphoneControl`, preserves all `allowedRoots` and `commandProfiles`, and keeps mode `0600`. It never prints the UDID or other sensitive contents.
3. Restart the already-installed **Mac Remote MCP Arkan agent** so it loads the opt-in. Do not use `device_disconnect` for this; that persists a revocation. Do not restart production VPS apps.
4. Deploy the updated **relay server** package to VPS through the existing reviewed, main-independent service process and restart **only** `remote-mcp-relay`. Refresh the installed custom plugin tools in ChatGPT. Expected discovery: **32 tools** (22 previous + 10 iPhone controls).
5. Ask `iphone_status`, `iphone_appium_server_start` if needed, `iphone_session_start`, and poll `iphone_status` until `sessionState: ready`. Then test screenshot/UI tree and a harmless tap in an approved app. Physical iPhone control still requires an online Mac and a working WDA; this does not bypass iOS lock-screen or app-level security.

If no `appium:bundleId` was in the local request, manually add the correct ID to `iphoneControl.allowedBundleIds` in the owner's `config.json` and restart the agent. No allowlist entry means `iphone_app_open` is denied, though other touch gestures can still control the active iPhone screen.

### Example owner configuration

```json
{
  "iphoneControl": {
    "enabled": true,
    "appiumPort": 4723,
    "udid": "REPLACE_WITH_REAL_DEVICE_UDID",
    "appiumExecutable": "/Users/arkan/Projects/iphone-control-poc/node_modules/.bin/appium",
    "appiumHome": "/Users/arkan/Projects/iphone-control-poc/.appium",
    "appiumCwd": "/Users/arkan/Projects/iphone-control-poc",
    "allowedBundleIds": ["com.example.approved-app"],
    "wdaLocalPort": 8100
  }
}
```

This is an excerpt, not a replacement for the full config file. The fields remain local; never put actual device IDs, OAuth tokens, or private keys in GitHub. `iphone_session_start` returns immediately; WebDriverAgent installation/signing may take several minutes and progress is visible through `iphone_status`.

### Why not the proposed `commandProfiles` workaround?

The suggested terminal profile used a **five-minute timeout** to run a long-lived Appium server. The agent's command manager would terminate that server after five minutes. It also allowed `curl` to post a locally mutable session JSON file, with no built-in screenshot/tap/swipe tools. This implementation instead uses fixed local HTTP routes and a separate tightly scoped launcher, with no broad remote command permission and no need to add the iPhone project to `allowedRoots`.

### Rollback

- Disable `iphoneControl.enabled` in local owner config and restart the Mac agent.
- Restore the one-time backup of the owner config only after comparing any newer legitimate changes; never silently overwrite them.
- Stop only the `remote-mcp-relay` service during a reviewed rollback of the deployed relay package; do not touch unrelated VPS services or Nginx.

## Verification scope

Automated tests exercise permission denial, asynchronous session creation, fixed XCUITest capabilities, UI/screenshot/tap/swipe/app activation, session stop, and the OAuth relay tool registry against a local fake Appium HTTP server. A **real physical iPhone / WebDriverAgent session** needs a manual acceptance test after the Mac owner opts in and the updated binaries are deployed.
