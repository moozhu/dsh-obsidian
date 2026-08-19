# 官方社区商店提交（SUBMISSION）

> **重要**：Obsidian 已把插件/主题提交流程从"GitHub PR"迁移到官方目录网站 **community.obsidian.md**。
> 不再需要 fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)、
> 修改 `community-plugins.json`、发起 Pull Request。旧 PR 流程已失效，请直接走下面的网站流程。
>
> 官方指南：[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)

提交前请逐项自查，然后按网站流程操作。审核周期通常几天到几周；被拒会附理由，改完重提即可。

## 自查清单

- [x] `manifest.json`：id `dsh-obsidian`（全小写无空格）、version `0.1.1`（semver）、author/authorUrl 为 `moozhu`、isDesktopOnly true
- [x] `versions.json`：`"0.1.1": "1.4.0"` 存在
- [x] 仓库有 `LICENSE`（MIT）
- [x] 仓库包含源码（`src/main.ts` 等）+ 构建产物（`main.js`），无混淆
- [x] 最新 Release（0.1.1）含 `main.js`、`manifest.json`、`styles.css`
- [x] README 有英文版 + 明确的 Node.js 依赖声明
- [ ] 附上截图/录屏（建议放 README 或提交说明，证明界面和功能）

## 提交步骤（网站流程）

1. **注册/登录** [community.obsidian.md](https://community.obsidian.md)（用你的 Obsidian 账号）。
2. **关联 GitHub**：在个人中心把 GitHub 账号（`moozhu`）关联到 Obsidian 账号，
   用于校验你确实拥有要提交的仓库。（官网文档叫 "Set up and claim" / "Add a plugin or theme"）
3. **添加插件**：进入目录，选 Add a plugin，填/关联你的仓库 `moozhu/dsh-obsidian`。
   目录会读取仓库默认分支的 `manifest.json`，并校验：
   - `id` 在所有已发布插件中唯一
   - 存在与 manifest 中 `version` 匹配的 GitHub Release 及配套 `main.js` / `manifest.json` / `styles.css`
   - 满足 [Developer policies](https://docs.obsidian.md/Developer+policies)
4. **处理自动审查反馈**：提交后网站自动审查并在该插件详情页显示指引/错误。
   有报错就改仓库 + 发布一个版本号递增的新 GitHub Release，网站会自动重新审查。
   审查通过即可被用户直接安装。
5. **上架后宣传**（可选）：
   - [论坛 Share & showcase](https://forum.obsidian.md/c/share-showcase/9) 发帖
   - [Discord `#updates`](https://discord.gg/veuWUTm) 频道宣布（需 `developer` 角色，
     [领取入口](https://discord.com/channels/686053708261228577/702717892533157999/830492034807758859)）

> 说明：用户安装你的插件时，Obsidian 会从"与你 manifest 中 version 相同 tag 的 GitHub Release"
> 下载 `main.js` / `manifest.json` / `styles.css`。因此 **Release 是必需的**（步骤 2 里已配好）。

## 版本发布（新功能/修复后）

1. 改代码 → `npm run build`（esbuild 打包出 `main.js`）
2. `release.ps1 -Version x.y.z`：自动改 manifest/versions、build、打 zip、建 GitHub Release
3. （可选）网站详情页会自动检测到新版本并重新审查，无需重新"提交"

## 被拒后的常见处理

- **"依赖未声明"** → 已在本 README 和提交说明声明 Node.js / `@deepseek-ai/dsh` 依赖；若仍被要求，补充到 README 更醒目位置
- **"功能与现有插件重复"** → 说明与其它嵌入类插件的差异（每库隔离 + 自动工作区绑定 + 模型配置共享）
- **"截图缺失"** → 在 README 补截图（面板打开 + DSH 界面 + 设置页）
