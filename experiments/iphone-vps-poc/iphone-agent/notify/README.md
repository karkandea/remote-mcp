# Stateless notification transport (preferred for free Apple Personal Team)

**Runtime RAM when idle: zero.** This one-shot Node script only runs when an authorized MCP tool dispatches a harmless command. It does not need Linux Appium, WDA, a persistent gateway, Tailscale, a Mac or an Apple APNs key.

1. Create a cryptographically random ntfy topic: `iphoneagent_` followed by 52 random lowercase hex characters (208 random bits; ntfy's topic limit is 64 characters). Store it in `/home/arkan-ops/iphone-agent-notify/topic` mode `0600`, owner `arkan-ops`.
2. Owner installs [ntfy for iOS](https://apps.apple.com/app/ntfy/id1625396347), grants notifications, and subscribes to that exact topic on `https://ntfy.sh`.
3. In iOS 26 **Shortcuts → Automation → Notification** choose **ntfy** and keyword `open_youtube` → **Open App: YouTube**. Repeat for each supported keyword; never enable a dangerous action. Apple may prompt for permissions, and the automation may not fire under all device states—must test on owner's iPhone 12.
4. On VPS, run as `arkan-ops`: `node /home/arkan-ops/iphone-agent-notify/trigger.mjs open_youtube`.
5. Confirm the actual iPhone opened YouTube. HTTP 200 from ntfy alone is **not** proof of execution.

Allowed keywords: `open_youtube`, `open_tiktok`, `open_spotify`, `open_starbridges`, `media_play_pause`. No attendance submits, sensitive text, custom URLs or arbitrary taps/swipes. Public ntfy topics are unprotected; entropy of this topic reduces guessing but this is a PoC, not an authorization-grade control channel. For future production, prefer private ntfy server with authenticated subscriptions or an equivalent push service.

The existing iPhone Control MCP plugin may add dedicated allowlisted dispatcher tools **only after** device-side automation passes. Existing production MCP and other VPS services remain unchanged.
