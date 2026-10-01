# Claude Code Connection Relay

Use Claude Code on a **laptop** with the Claude Pro/Max login of another **PC**, with no login on the laptop.

```
 LAPTOP                          PC (server)                        Anthropic
┌──────────────┐  relay secret  ┌──────────────────┐  OAuth token  ┌───────────────────┐
│ claude (CLI) │ ─────────────▶ │ node relay.mjs   │ ────────────▶ │ api.anthropic.com │
│ your code    │ ◀───────────── │ (logged-in PC)   │ ◀──────────── │                   │
└──────────────┘    responses   └──────────────────┘               └───────────────────┘
```

- **Only the PC runs the relay.** The laptop just needs Claude Code and a settings file.
- **Your code stays on the laptop.** All file edits and commands run on the laptop. The PC only passes the model traffic through.
- **The laptop never sees your OAuth token.** It only holds a relay secret, and the relay swaps that for the real token.
- **Token refreshes are picked up automatically.** The relay re-reads the PC's credentials file on every request.

---

## Requirements

| Machine | Needs |
|---|---|
| PC (server) | [Node.js](https://nodejs.org) 18+, Claude Code **logged in** with a Pro/Max account |
| Laptop (client) | Claude Code installed (**not** logged in) |
| Both | Same network (home Wi-Fi/LAN) **or** [Tailscale](https://tailscale.com) on both to connect from anywhere |

---

## Part 1 — PC setup (server)

### 1. Get the code

```powershell
git clone https://github.com/Blankscreen-exe/claude-code-connection-relay.git
cd claude-code-connection-relay
```

### 2. Make sure Claude Code is logged in on the PC

Run `claude` once and confirm you're logged in with your Pro/Max account. The relay reads the token from:

- Windows: `C:\Users\<you>\.claude\.credentials.json`
- Linux: `~/.claude/.credentials.json`

> macOS keeps credentials in the Keychain, so this file may not exist there. In that case, point the relay at a credentials JSON with the `CLAUDE_CREDENTIALS` environment variable.

### 3. Start the relay

```powershell
node relay.mjs --host 0.0.0.0 --port 8787
```

You should see:

```
Generated new relay secret in ...\relay.secret
Claude relay listening on http://0.0.0.0:8787
Using credentials from C:\Users\<you>\.claude\.credentials.json
OAuth token found and not expired.
```

Keep this window open. The relay only works while it's running.

### 4. Copy the relay secret

On first run, the relay creates a file named **`relay.secret`** in the project folder. Open it and copy the long hex string. You'll paste it on the laptop in Part 2.

> **Treat this like a password.** Anyone with this secret who can reach the PC can use your Claude subscription. It's already in `.gitignore`.

### 5. Allow the port through Windows Firewall (one time)

Open **PowerShell as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Claude relay" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

> This only allows connections on **Private** networks. Make sure your home Wi-Fi is set to *Private* in Windows network settings.

### 6. Find the PC's IP address

**Same Wi-Fi/LAN:** run `ipconfig` and note the **IPv4 Address** (for example `192.168.1.50`).

**From anywhere (Tailscale):** install Tailscale on both machines and sign in with the same account. Then on the PC run:

```powershell
tailscale ip -4
```

It prints an address like `100.101.102.103`. For extra safety, start the relay so it **only** listens on Tailscale:

```powershell
node relay.mjs --host 100.101.102.103 --port 8787
```

---

## Part 2 — Laptop setup (client)

The laptop does **not** need this repo, Node for the relay, or a Claude login.

### 1. Install Claude Code

Install it the usual way, but **don't run `/login`**.

### 2. Point Claude Code at the PC

Create or edit the Claude settings file on the laptop:

- Windows: `C:\Users\<you>\.claude\settings.json`
- macOS/Linux: `~/.claude/settings.json`

Put this in it, replacing the two placeholders:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<PC-IP>:8787",
    "ANTHROPIC_AUTH_TOKEN": "<paste the contents of relay.secret>",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

Example:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://192.168.1.50:8787",
    "ANTHROPIC_AUTH_TOKEN": "3f9a1c...e07b",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> If the file already has other settings, add the `"env"` block alongside them instead of replacing the whole file.

### 3. Test the connection (optional)

From the laptop:

```bash
curl http://<PC-IP>:8787/api/hello -I
```

A `200 OK` response means the laptop can reach the relay.

### 4. Use Claude Code

```bash
cd path/to/your/project
claude
```

That's it. Claude Code works as usual, editing the laptop's files while using the PC's subscription. Each request shows up as a log line in the PC's relay window.

> A few features that depend on a claude.ai account login (claude.ai connectors, account and usage screens) may not work on the laptop because it isn't logged in to an account. Normal coding, tools, file edits and model selection work.

### 5. VS Code (optional)

The Claude Code VS Code extension reads the same `~/.claude/settings.json`, so it also goes through the relay. You don't need any extra relay setup.

1. Install the **Claude Code** extension in VS Code on the laptop.
2. If the extension shows a login screen, open VS Code **Settings** (`Ctrl+,`), search for **"Claude Code: Disable Login Prompt"** and enable it. In `settings.json` this is:

   ```json
   "claudeCode.disableLoginPrompt": true
   ```

3. Restart VS Code and open the Claude Code panel. Requests should appear in the PC's relay log.

> The terminal setup is tested. VS Code should work through the same config, but if it doesn't, check that the `env` block in `~/.claude/settings.json` is correct and that the relay log shows incoming requests.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Laptop: `invalid relay secret` (401) | `ANTHROPIC_AUTH_TOKEN` on the laptop doesn't match `relay.secret` on the PC. Copy it again with no extra spaces or newlines. |
| Laptop: `OAuth token expired ... run claude on the relay PC` (503) | The PC's login token expired. Run `claude` on the PC (send any message) so it refreshes. No relay restart needed. |
| Laptop: connection refused / timeout | Relay isn't running, the IP is wrong, the firewall rule is missing, or the network is set to *Public*. Check with `curl http://<PC-IP>:8787/api/hello -I`. |
| Laptop asks you to log in | The `env` block isn't being read. Check the path and JSON syntax of `settings.json`. |
| `Generated new relay secret` shows up again | `relay.secret` was deleted. Copy the new secret to the laptop. |

---

## Options

| Flag / env var | Default | Meaning |
|---|---|---|
| `--host` / `RELAY_HOST` | `0.0.0.0` | Interface to listen on |
| `--port` / `RELAY_PORT` | `8787` | Port to listen on |
| `RELAY_SECRET` | contents of `relay.secret` | Use this secret instead of the file |
| `CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` | Path to the PC's Claude credentials |

**Rotate the secret:** delete `relay.secret`, restart the relay, and update the laptop's `settings.json`.

---

## Security notes

Two layers protect the relay:

1. **The relay secret.** This is the "API key" the laptop holds (`ANTHROPIC_AUTH_TOKEN`). Every request must carry it, and anything without it is rejected with a 401. It is **not** your real Claude token. If it leaks, rotate it (see above) and your actual login on the PC is unaffected.
2. **The network.** The link between the laptop and the PC is **plain HTTP**, so the secret travels unencrypted. On a home LAN, another device on the same Wi-Fi could capture it. **Tailscale** encrypts all traffic between the two machines and keeps the relay unreachable from outside your tailnet. Use Tailscale (with `--host <tailscale-ip>`) whenever you're away from home or on shared Wi-Fi.

Also:
- **Never port-forward 8787 on your router** or expose the relay to the internet.
- Use the relay only on your own devices. Sharing the secret with anyone else is sharing your account.
- Laptop usage counts against the PC account's normal subscription limits.
