# DSH for Vaults

> 🌐 [简体中文](README.zh-CN.md)

Embeds the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH) native Web UI **inside Obsidian**. Each vault gets its **own fully isolated DSH instance**: open a vault and DSH starts with that vault as its workspace. Session histories stay per-vault and never mix.

**Why you'll want it:**

- 🔀 **rc / alpha kernels both supported** — old session data is migrated automatically on upgrade, so history survives kernel jumps (browser-auth alpha works out of the box)
- 🗂 **One instance per vault** — isolated port, data directory and sessions per vault; open several vaults side by side, zero interference
- 🎛 **You decide when to update** — stable / alpha channels in settings; updates only install after explicit confirmation. **No silent upgrades, ever.**

## Features

- **Native webview embed**: the real DSH UI inside the panel (token-authenticated, direct to localhost — no proxy layer), identical to the browser experience
- **rc / alpha compatibility + automatic data migration**: upgrading to alpha (browser-auth edition) auto-migrates old session data (both single-file and sharded storage layouts), history carried over seamlessly
- **Backup before migration**: old data is backed up locally before any migration — custom path supported, one click to reveal the backup folder in Explorer
- **Per-vault isolation**: vault-dedicated data dir (`%LOCALAPPDATA%\dsh-obsidian\<vaultHash>`) keeps notes clean, skips OneDrive sync, and separates sessions between vaults completely
- **Kernel version of your choice**: pick the **stable** or **alpha experience** channel in settings; check updates per channel; install only after confirmation — startup never touches the network to change versions
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
4. **Status bar**: bottom-left shows the instance state (`DSH: running @ 3090`)

## Kernel versions & update policy

**No auto-updates, by default.** Startup only uses locally installed kernel versions (picks the highest one) and never goes online to change versions.

When you want a new version — Settings → "dsh version update":

| Channel | What it tracks |
|---------|----------------|
| **Stable** | npm official channel (`latest`) — whatever the official release is |
| **alpha experience** | npm preview channel (`alpha`) — newest capabilities (e.g. the browser-auth Web UI) |

- Pick a channel → "Check update" → confirm the popup → install (progress fully visible)
- Upgrading from older kernels to alpha **auto-migrates session data and backs it up first** — history survives
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
| dsh version update | Channel dropdown (stable / alpha experience) + check-update button; installs only after confirmation |
| Data backup dir | Old data backed up here before migration; empty = default dir (path shown), 📁 reveals the folder in Explorer |
| Base port | Port pool start (default 3090, avoids the common desktop port 3080) |
| Auto-start on Obsidian open | Starts the vault's instance automatically |
| Stop instance on Obsidian close | Frees memory on close; disable to keep it resident for instant relaunch |
| Panel location | Right sidebar / Left sidebar / Tab |

## FAQ

- **Startup timeout**: verify Node.js is installed; set "dsh executable path" to the output of `where dsh.cmd` (or npm global path `%APPDATA%\npm\dsh.cmd`)
- **Blank panel**: confirm the status bar says "running"; if still blank, restart Obsidian
- **Slow first launch**: expected — npx downloads the DSH package; subsequent launches are instant
- **Old status after switching vaults**: each vault has its own instance; the status bar shows the current window's instance

## Development

```powershell
npm install
npm run dev       # tsc watch
npm run typecheck # type-check only
npm run build     # type-check + esbuild bundle → main.js (bundles the yaml dep)
```

## Release

See [RELEASE.md](RELEASE.md).
