# DSH for Vaults

> 🌐 [简体中文](README.zh-CN.md)

Embeds the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) native Web UI **inside Obsidian**. Each vault gets its **own fully isolated DSH instance**: open a vault and DSH starts with that vault as its workspace. Session histories stay per-vault and never mix.

**Why you'll want it:**

- 🗂 **One instance per vault** — isolated port, data directory and sessions per vault; open several vaults side by side, zero interference
- 🧲 **Two-way Obsidian ⇄ DSH bridge** — right-click selected text to hand DSH the exact file + line range; then click any vault file path DSH mentions to jump straight back to that note. Zero copy-paste round-trips
- ⌨️ **Hotkeys that don't get eaten** — the Obsidian shortcuts you configured keep working while the DSH panel has focus
- 🎛 **You decide when to update** — tracks the official stable channel; updates install only after explicit confirmation. **No silent upgrades, ever.**

## Features

- **Embedded webview UI**: the real DSH interface runs in a dedicated Electron webview (persistent per-vault session storage, cookie-safe token auth) — identical to the browser experience
- **Send selection to DSH**: right-click (or command palette) on selected text — a locator line (file + `L:col` range) lands in the DSH composer; the model reads the region on demand
- **Open paths in Obsidian**: click a vault file path shown in the DSH chat and the note opens in Obsidian (focuses an existing tab, or opens a new one); a missing file gets a clear notice, while out-of-vault and binary paths keep DSH's own behavior
- **Hotkey passthrough**: Obsidian shortcuts (Command palette, Quick switcher, Settings…) keep firing while focus is inside the DSH panel — mirrors your own hotkey configuration, one toggle in settings
- **Boot diagnostics**: settings shows a per-stage timing trace of the last panel start (config sync / probe / port / kernel / UI load), one-click copy for bug reports
- **Bottom padding**: adjustable 0–40px footer with a divider line, so the Obsidian status bar never covers panel content
- **Automatic data migration**: upgrading an older kernel to the current browser-auth release auto-migrates session data (single-file and sharded layouts), history carried over seamlessly
- **Backup before migration**: old data is backed up locally before any migration — custom path supported, one click to reveal the backup folder in Explorer
- **Per-vault isolation**: vault-dedicated data dir (`%LOCALAPPDATA%\dsh-obsidian\<vaultHash>`) keeps notes clean, skips OneDrive sync, and separates sessions between vaults completely
- **Updates only on confirmation**: check for the newest stable kernel in settings; install happens only after you confirm — startup never touches the network to change versions
- **Registry mirror fallback**: npm official source fails → auto-switches to the npmmirror mirror (friendlier on mainland networks)
- **Visible install progress**: persistent global notice with elapsed-time ticker, plus clear success/failure result — no more "did it actually install?"
- **Model config once, used everywhere**: one-way sync of providers & API credentials from your main DSH to every vault — add a vendor/key once, no per-vault re-setup
- **Diagnosable startup failures**: real logs with error tail on failure; stale process trees are cleaned up on timeout — not just a bare "startup timed out"

## Requirements

- Obsidian desktop (v1.4+, Windows)
- [Node.js](https://nodejs.org) — detected at startup; the panel shows a download link if missing

## Install

### Community Store

Settings → Community plugins → Browse → search "DSH for Vaults" → Install.

### BRAT (GitHub-based, with auto-updates)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. BRAT Settings → Add Beta plugin → enter `moozhu/dsh-obsidian` → Add
3. Updates arrive automatically via BRAT

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/moozhu/dsh-obsidian/releases)
2. Place them in `<your-vault>\.obsidian\plugins\dsh-ob\`
3. Restart Obsidian → Settings → Community plugins → enable "DSH for Vaults"

## Quick start

1. **Open the panel**: whale icon in the left ribbon, or Ctrl+P → "Open DSH panel"
2. **Wait for startup**: the panel shows "Starting @ port …", then loads the DSH UI with your vault as the workspace (first launch ~10–30 s while npx installs the kernel)
3. **Chat**: the active workspace is your vault — manage notes with AI right away
4. **Work with notes**: select text in any note → right-click → "Send selection to DSH" — DSH reads exactly that region; click a vault path in DSH's reply to jump back to the note
5. **Status bar**: bottom-left shows the instance state (`DSH: running @ 3090`)

## Kernel versions & update policy

**No auto-updates, by default.** Startup only uses locally installed kernel versions (picks the highest one) and never goes online to change versions.

When you want a new version — Settings → "dsh version update": the plugin checks the official **stable channel** (npm `latest`) and installs only after you confirm.

- Upgrading from older kernels **auto-migrates session data and backs it up first** — history survives
- Flaky network? Auto-falls back to the npmmirror mirror for queries and downloads

## Multi-vault behavior (one instance per vault)

| Scenario | Behavior |
|----------|----------|
| Open vault A (first time) | Deterministic port (hash + collision bump), starts DSH with A as workspace |
| Open vault B at the same time | Fully independent: different port, process, workspace and sessions |
| Same vault in two windows | Shares the same instance (same port), no duplicate startup |
| Close vault B's window | Stops the instance on close; history kept in the vault's dedicated data dir |
| Re-open vault B | Re-launches on the same port; history is still there |
| Port taken / manual DSH running | Only manages its own instances; finds a free port instead of touching manual ones |

## Shared model configuration (set up once, used everywhere)

Your **main DSH** (e.g. the desktop instance at `http://127.0.0.1:3080`, whose data lives in `~/.dsh`) is the **single source of truth** for model *infrastructure*. On every vault instance startup, the plugin one-way syncs from the main instance to that vault:

- **LLM providers** (`llm-pi-ai` and `llm-deepseek` namespaces in `settings.yaml`: base URLs, model lists, routes)
- **API credentials** (`.credentials.yaml`)

Add a new vendor or API key once, then just open (or reopen) any vault panel — available everywhere, no per-vault re-setup (DSH hot-reloads `settings.yaml`).

**Not synced on purpose** — each vault keeps its own choice:

- **Default model route** (`agent-default-model`): e.g. main uses DeepSeek, a vault uses GPT/MiMo
- **Search model** (`web-search-deepseek`): each vault may use its own search model
- **Plugin systems** (`profiles` / node_modules): different vaults can use different plugin sets

Conflict handling: provider/credential dictionaries use a **union merge** (vault-only entries kept, shared entries overridden by main, main-only entries added); direction is strictly **main → vault, one-way** — changes inside a vault never write back to the main instance.

## Data & privacy

- The plugin is a **launcher + embedded client**: no DSH implementation bundled, talks to DSH only over localhost (127.0.0.1), no telemetry, no relay
- Session history, model config and API credentials live in the vault's dedicated local dir (`%LOCALAPPDATA%\dsh-obsidian\`) — outside your vault, never synced
- DSH itself makes outbound requests (model APIs etc.) as needed, determined by your tasks

## Settings

| Setting | Description |
|---------|-------------|
| dsh executable path | Leave empty for auto-detection (npm global → managed dir → npx cache → online npx); fill manually only if detection fails |
| dsh version update | Check the stable channel for updates; installs only after confirmation |
| Data backup dir | Old data backed up here before migration; empty = default dir (path shown), 📁 reveals the folder in Explorer |
| Base port | Port pool start (default 3090, avoids the common desktop port 3080) |
| Auto-start on Obsidian open | Starts the vault's instance automatically |
| Stop instance on Obsidian close | Frees memory on close; disable to keep it resident for instant relaunch |
| Hotkey passthrough | Obsidian shortcuts keep working while the DSH panel is focused (mirrors your hotkey settings) |
| Reverse bridge | Click a vault file path in the DSH chat to open that note in Obsidian |
| Panel location | Right sidebar / Left sidebar / Tab |
| Panel bottom padding | 0–40px footer gap with a divider line, live-adjustable |
| Boot timing diagnostics | Per-stage timing of the last startup, one-click copy for feedback |

## FAQ

- **Startup timeout**: verify Node.js is installed; set "dsh executable path" to the output of `where dsh.cmd` (or npm global path `%APPDATA%\npm\dsh.cmd`)
- **Blank panel**: confirm the status bar says "running"; if still blank, restart Obsidian
- **Slow first launch**: expected — npx downloads the DSH package; subsequent launches are instant
- **Old status after switching vaults**: each vault has its own instance; the status bar shows the current window's instance
- **An Obsidian shortcut doesn't fire inside the panel**: only shortcuts actually bound in Obsidian's hotkey settings are forwarded — if the key does nothing in plain Obsidian either, bind it first (Settings → Hotkeys)

## Development

```powershell
npm install
npm run dev       # tsc watch
npm run typecheck # type-check only
npm run build     # type-check + esbuild bundle → main.js (bundles the yaml dep)
```

## Release

See [RELEASE.md](RELEASE.md).
