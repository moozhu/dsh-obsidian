# DSH for Obsidian

> 🌐 [简体中文](README.zh-CN.md)

Embeds the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) web UI inside Obsidian. Each vault gets its **own isolated DSH instance**: open a vault and DSH starts with that vault as its workspace automatically. Session histories stay per-vault and never mix.

> The plugin is a **launcher + plain iframe client**. It does not bundle or call any DSH API — upgrade DSH, restart the panel, and you're on the new kernel instantly. The plugin itself never needs an update for that.

## Requirements

- Obsidian desktop (v1.4+, Windows)
- [Node.js](https://nodejs.org) — the plugin detects it at startup and shows a download link in the panel if missing

## Install

### Community Store (once approved)

Settings → Community plugins → Browse → search "DSH for Obsidian" → Install.

### BRAT (GitHub-based, with auto-updates)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. BRAT Settings → Add Beta plugin → enter `moozhu/dsh-obsidian` → Add
3. Updates arrive automatically via BRAT

### Manual

1. Download `dsh-obsidian-x.y.z.zip` from [Releases](https://github.com/moozhu/dsh-obsidian/releases)
2. Extract to `<your-vault>\.obsidian\plugins\dsh-obsidian\` (must contain `main.js`, `manifest.json`, `styles.css`)
3. Restart Obsidian → Settings → Community plugins → enable "DSH for Obsidian"

## Usage

1. Click the whale icon in the left ribbon (or run "Open DSH panel" from Ctrl+P)
2. Wait for startup — the panel shows "Starting @ port …", then loads the DSH UI with your vault as the active workspace (first launch ~10-30 s while npx installs the package)
3. Start chatting to manage your notes with AI
4. The status bar (bottom-left) shows the current instance state (`DSH: running @ 3090`)

## Features

- One DSH instance per vault: isolated workspaces and chat histories
- The vault root is registered as the default workspace — no manual setup
- DSH server starts/stops with Obsidian (configurable)
- Session data lives outside the vault (in `%LOCALAPPDATA%`), so notes stay clean
- DSH's built-in workspace switcher still works — you can reference other directories when needed

## Settings

| Setting | Description |
|---------|-------------|
| dsh executable path | Leave empty for auto-detection (npm global → npx cache → online npx); only fill in manually if auto-detect fails |
| Base port | Starting port for each vault (default 3090, avoids the common desktop port 3080) |
| Auto-start on Obsidian open | Automatically starts the vault's DSH instance when Obsidian opens |
| Stop instance on Obsidian close | Stops the process on close; disable to keep it running in background for faster re-launch |
| Panel location | Right sidebar / Left sidebar / Tab |

## Multi-vault behavior (one instance per vault)

| Scenario | Behavior |
|----------|----------|
| Open vault A (first time) | Assigns a deterministic port, starts DSH with A as workspace |
| Open vault B at the same time | Fully independent: different port, process, workspace, and sessions |
| Same vault in two windows | Shares the same instance (same port), no duplicate startup |
| Close vault B's window | Stops the instance on close; session history preserved in `%USERPROFILE%\.dsh` |
| Re-open vault B | Re-launches on the same port; history is still there |
| Port occupied / manual DSH running | Only manages its own instances; finds a free port instead of touching manual ones |

## DSH kernel upgrade

- Zero coupling to DSH internals: upgrade DSH → restart the panel and you're on the new kernel. **No plugin update needed.**
- **Auto-updates by default**: runs `npx --yes @deepseek-ai/dsh` on each launch, checking for new versions automatically.
- **Lock a version**: set the "dsh executable path" setting to a local fixed installation.

## FAQ

- **Startup timeout**: verify Node.js is installed; fill in the "dsh executable path" with the output of `where dsh.cmd` (or npm global path `%APPDATA%\npm\dsh.cmd`)
- **Blank panel**: confirm the status bar says "running"; if still blank try restarting Obsidian
- **Slow first launch**: expected — npx downloads the DSH package; subsequent launches are instant
- **Old status after switching vaults**: each vault has its own instance; status bar shows the instance for the current window's vault

## Development

```powershell
npm install
npm run dev      # tsc watch
npm run build    # build → main.js
```

## Release

See [RELEASE.md](RELEASE.md).
