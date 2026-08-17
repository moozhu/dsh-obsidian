# 官方社区商店提交（SUBMISSION）

提交前请逐项自查，然后按下面的模板发 PR。审核周期通常几天到几周；被拒会附理由，改完可重新提交。

## 自查清单

- [x] `manifest.json`：id `dsh-obsidian`（全小写无空格）、version `0.1.1`（semver）、author/authorUrl 为 `moozhu`、isDesktopOnly true
- [x] `versions.json`：`"0.1.1": "1.4.0"` 存在
- [x] 仓库有 `LICENSE`（MIT）
- [x] 仓库包含源码（`src/main.ts`）+ 构建产物（`main.js`），无混淆
- [x] 最新 Release（0.1.1）含 `main.js`、`manifest.json`、`styles.css`
- [x] README 有英文版 + 明确的 Node.js 依赖声明
- [ ] 附上截图/录屏（建议放 README 或 PR 描述，证明界面和功能）

## 提交步骤

1. Fork https://github.com/obsidianmd/obsidian-releases
2. 编辑 `community-plugins.json`，在数组末尾加：

```json
{
  "id": "dsh-obsidian",
  "name": "DSH for Obsidian",
  "author": "moozhu",
  "description": "Embed the DeepSeek Harness web UI in Obsidian, with one isolated workspace per vault.",
  "repo": "moozhu/dsh-obsidian"
}
```

3. 发 PR，标题与描述模板：

---

**PR 标题**：
```
Add plugin: DSH for Obsidian
```

**PR 描述**（复制后按实际修改）：

```
# Add DSH for Obsidian

## Description

Embeds the DeepSeek Harness web UI (an open-source AI coding/notes assistant) inside Obsidian. Each vault gets its own isolated DSH instance with the vault root as the default workspace, so you can manage your notes with AI without leaving Obsidian.

## External dependency notice

This plugin is a **launcher + plain iframe client**. It does not bundle or call any DSH API. It requires:
- **Node.js** (detected automatically at startup; the panel shows an official download link when missing)
- The `@deepseek-ai/dsh` npm package, fetched automatically via `npx` (kept up to date; falls back to the local cache when offline)

This is the same model as other CLI/agent-bridge plugins. All external software is optional to Obsidian itself; the plugin fails gracefully with clear guidance when prerequisites are missing.

## Checklist

- [x] My Plugin has a proper manifest.json and complies with all the requirements of the plugin guidelines
- [x] My Plugin has a valid LICENSE file (MIT)
- [x] My Plugin has a descriptive README with English text and clear installation instructions
- [x] The latest release contains main.js, manifest.json and styles.css
- [x] The repository contains the full source code (src/main.ts), built without obfuscation
- [x] I have tested the plugin on Obsidian desktop and it works as documented

## Links

- Repo: https://github.com/moozhu/dsh-obsidian
- Latest release: https://github.com/moozhu/dsh-obsidian/releases/tag/0.1.1
```

---

## 被拒后的常见处理

- **"依赖未声明"** → 已在 PR 描述和 README 声明；若仍被要求，补充到 README 更醒目的位置
- **"功能与现有插件重复"** → 说明与其它嵌入类插件的差异（每库隔离 + 自动工作区绑定）
- **"截图缺失"** → 补 README 截图（面板打开 + DSH 界面 + 设置页）
