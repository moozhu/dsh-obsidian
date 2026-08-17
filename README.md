# DSH for Obsidian

在 Obsidian 中嵌入 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) Web UI。**每个库（vault）一个独立的 DSH 实例**：打开哪个库，DSH 就自动以该库为工作区启动，会话历史按库长期沉淀、互不串扰。

> 架构上插件只是「启动器 + 纯 iframe 客户端」：不调用 DSH 任何 API，DSH 内核升级后插件无需改动、无需卸载，重启实例即用上新内核。

---

## English

**DSH for Obsidian** embeds the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) web UI inside Obsidian. Each vault gets its **own isolated DSH instance**: open a vault and DSH starts with that vault as its workspace automatically. Session histories stay per-vault and never mix.

### Features

- One DSH instance per vault: isolated workspaces and chat histories
- The vault root is registered as the default workspace — no manual setup
- Automatically starts/stops the DSH server with Obsidian (configurable)
- Session data lives outside the vault (in `%LOCALAPPDATA%`), so your notes stay clean
- Workspaces can still be added/switched inside DSH if you need more

### Requirements

- Obsidian desktop (v1.4+, Windows)
- [Node.js](https://nodejs.org) — the plugin detects it at startup and shows a download link in the panel if missing

### Architecture & how it works

The plugin is a **launcher + plain iframe client**. It does not bundle or call any DSH API:

1. On first open it starts a local `dsh web` server (via `npx`, keeping the kernel up to date automatically; falls back to the local cache when offline)
2. The DSH UI loads in an iframe panel (sidebar or tab)
3. Each vault gets a deterministic port and its own data directory (`DSH_HOME`), so vaults never interfere with each other or with the desktop app

Because the plugin never depends on DSH internals, upgrading DSH is just a matter of restarting the panel — the plugin itself never needs an update for that.

### Install

- **Community store**: search "DSH for Obsidian" (once approved)
- **BRAT**: add `moozhu/dsh-obsidian`
- **Manual**: download the release zip and extract to `.obsidian/plugins/dsh-obsidian/`

### Usage

Click the whale icon in the left ribbon (or run "Open DSH panel" from the command palette). The panel shows a start status, then loads the DSH UI with your vault as the active workspace. Start chatting to manage your notes.

---

## 前置条件

- Obsidian 桌面版（v1.4+，Windows）
- [Node.js](https://nodejs.org/zh-cn)（插件启动实例前会自动检测；未安装时面板会显示下载入口）

## 安装

### 方式一：官方社区商店（上架后）

设置 → 第三方插件 → 浏览 → 搜索「DSH for Obsidian」→ 安装。

### 方式二：BRAT（GitHub 仓库分发，支持自动更新）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. BRAT 设置 →「Add Beta plugin」→ 填入 `moozhu/dsh-obsidian` → 添加
3. 更新：BRAT 会随仓库版本自动提示更新

### 方式三：手动安装

1. 下载 Release 的 `dsh-obsidian-x.y.z.zip`
2. 解压到 `<你的库>\.obsidian\plugins\dsh-obsidian\`（解压后该目录下应有 `main.js`、`manifest.json`、`styles.css`）
3. 重启 Obsidian → 设置 → 第三方插件 → 启用「DSH for Obsidian」

## 使用

1. **打开面板**：左侧丝带栏的鲸鱼图标，或命令面板（Ctrl+P）搜「打开 DSH 面板」
2. **等待启动**：面板显示「正在启动 @ 端口 ...」，就绪后自动载入 DSH 界面（首次约 10~30 秒，含 npx 在线安装）
3. **开始对话**：DSH 里当前工作区就是你的库目录，直接用 AI 管理笔记
4. **状态栏**：左下角显示当前实例状态（`DSH: 运行中 @ 3090`）

### 设置项

| 设置 | 说明 |
|------|------|
| dsh 可执行文件路径 | 留空自动探测（npm 全局 → npx 缓存 → 在线 npx）；探测失败才需要手动填 |
| 基础端口 | 端口池起点（默认 3090，避开桌面版常用的 3080） |
| 打开 Obsidian 时自动启动 | 打开库就自动拉起实例 |
| 关闭 Obsidian 时停止实例 | 关窗即释放内存；关闭则常驻后台、下次秒开 |
| 面板位置 | 右侧边栏 / 左侧边栏 / 新标签页 |

## 多库行为（每库一实例）

| 场景 | 行为 |
|------|------|
| 打开库 A（首次） | 分配端口（确定性哈希 + 冲突上移），以库 A 为工作区启动，就绪后载入 |
| 同时再开库 B | 完全独立：不同端口、不同进程、不同工作区与会话 |
| 同一库开两个窗口 | 共享同一实例（同一端口），不会重复启动 |
| 关闭库 B 窗口 | 默认随 Obsidian 关闭停止进程；会话历史保留在 `%USERPROFILE%\.dsh` |
| 重开库 B | 重新拉起同端口实例，历史会话都在 |
| 端口被占 / 已有手动开的 DSH | 只认自己管理的实例；检测到占用自动换端口，不动手动启动的服务 |

> 后续计划支持「所有库共享一个实例、在 DSH 里切换工作区」模式（设置项二选一）。

## DSH 升级

- 插件与 DSH 内核零 API 耦合：DSH 升级 → 重启实例即生效，插件本体**不需要**升级或重装
- 跟随最新版：默认走 `npx --yes @deepseek-ai/dsh`（每次启动实例时拉取最新）；想锁定版本，在设置里把「dsh 可执行文件路径」填成本地固定安装路径即可

## 常见问题

- **启动超时**：检查 Node.js 是否安装；把「dsh 可执行文件路径」手动填成 `where dsh.cmd` 的输出（或 npm 全局路径 `%APPDATA%\npm\dsh.cmd`）
- **面板空白**：确认实例状态栏显示「运行中」；若仍空白请尝试重启 Obsidian
- **首次启动慢**：正常，npx 在线拉取 DSH 包；之后秒开
- **换库后状态显示旧的**：每个库独立实例，状态栏显示的是当前窗口库的实例

## 开发

```powershell
npm install
npm run dev      # tsc watch 模式
npm run build    # 构建（tsc → main.js）
```

## 发布

见 [RELEASE.md](RELEASE.md)。
