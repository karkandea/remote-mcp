# Enroll a Windows laptop

Windows connects to the same MCP app and relay as the Mac. The relay keeps one channel per device. Existing Mac and VPS tools use their original destinations. Windows tools have an explicit `windows_` prefix and return an offline error when Windows is disconnected.

## On Windows PowerShell 5.1

Use a standard Windows account that owns the files being shared. Install Node.js 22 or later, open PowerShell in this checkout, and run:

```powershell
npm.cmd ci
npm.cmd run build
$allowed = Join-Path $env:USERPROFILE 'RemoteMcpWorkspace'
New-Item -ItemType Directory -Force -Path $allowed | Out-Null
Set-Content -Encoding UTF8 -Path (Join-Path $allowed 'mcp-test.txt') -Value 'Ais Windows MCP test'
node .\dist\cli.js windows-init wss://mcp.dualangka.com/agent/ws "$allowed"
```

The last command prints a 64-character **fingerprint**. Give the fingerprint to the relay operator. The private token stays in `%LOCALAPPDATA%\RemoteMcpArkan\enrollment.json`. Keep that folder under the Windows account's permissions and outside the shared folder. To show the fingerprint again, run `node .\dist\cli.js windows-fingerprint`.

After the relay operator enables the fingerprint, start the agent:

```powershell
node .\dist\cli.js windows-agent
```

Keep that window open while the device should be online. The agent reconnects automatically after a network drop. The MCP client can use `windows_device_status` to find the approved folder and `windows_fs_read` to read `mcp-test.txt`. List, stat and literal search are also available in that folder.

## Enable file writes

Windows starts with read-only file access. To enable writes, stop the running agent, then run the following commands locally under the same Windows account:

```powershell
node .\dist\cli.js windows-enable-writes
node .\dist\cli.js windows-agent
```

The portable update includes `3-Enable-Windows-Writes.cmd` for the first command. Extract it into the existing portable agent folder and keep the same Windows enrollment. Run `2-Start-Windows.cmd` to restart the agent. The MCP client can check `writesEnabled` in `windows_device_status`.

Write tools operate on bounded UTF-8 files within the approved folder. `windows_fs_create` requires an existing parent directory and fails if the file already exists. `windows_fs_apply_patch` replaces one occurrence of the expected text. `windows_fs_delete` permanently removes a file. Both patch and delete require the SHA-256 reported by `windows_fs_read`, so they can detect changes since the last read.

To disable writes, run `node .\dist\cli.js windows-disable-writes` or `4-Disable-Windows-Writes.cmd` and restart the agent.

Press Ctrl+C in the agent window to take it offline. To persistently revoke Windows file access, run `node .\dist\cli.js windows-stop` or call `windows_device_disconnect` from the MCP client. To re-enable it, run `node .\dist\cli.js windows-resume` locally and start the agent if needed.

## On the relay

Set `RELAY_WINDOWS_DEVICE_FINGERPRINT` to the client's fingerprint in the relay service environment and restart the relay. Use the same `/agent/ws` route and keep the existing Mac token. The Windows agent sends its own bearer token and a device header over WSS. The relay hashes the token and compares it against the enrolled fingerprint. Nginx must pass the `X-Remote-MCP-Device` request header through to the upstream. The existing example passes client request headers by default.

The Windows tools appear after the fingerprint is configured. The relay detects older Windows agents and returns `AGENT_UPDATE_REQUIRED` for write requests. If a ChatGPT session has cached the app's tool list, refresh its configuration or reconnect it after the relay update.

To remove a device, remove its fingerprint and restart the relay. To enroll a replacement, take the previous Windows agent offline, remove the previous fingerprint, rename the old local enrollment directory, then repeat enrollment to generate a new token and fingerprint.
