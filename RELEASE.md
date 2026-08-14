# 发布流程（RELEASE）

## 一、准备 GitHub 仓库

1. 在 GitHub 建仓库（例如 `moozhu/dsh-obsidian`，Public）
2. 把本项目推上去（`node_modules` 已被 .gitignore 排除；`main.js` 构建产物要提交）：
   ```powershell
   cd E:\OneDrive\deepseek\dsh-obsidian
   git init
   git add -A
   git commit -m "v0.1.0: 每库一实例的 DSH 嵌入面板"
   git branch -M main
   git remote add origin https://github.com/moozhu/dsh-obsidian.git
   git push -u origin main
   ```
3. `manifest.json` 里 `author` / `authorUrl` 已填 `moozhu`（与仓库归属一致，商店审核要求两者匹配）

## 二、BRAT 分发（立即可用，无需审核）

仓库推上去后，别人就能装了：

1. 对方安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. BRAT 设置 → Add Beta plugin → 填 `moozhu/dsh-obsidian`
3. BRAT 会从仓库根读 `main.js` + `manifest.json` + `versions.json`，版本更新自动提示

## 三、发正式 Release（手动安装 + 商店前置）

每次发版：

```powershell
cd E:\OneDrive\deepseek\dsh-obsidian
.\release.ps1 -Version 0.1.1    # 自动：更新 manifest/versions.json → 构建 → 打 zip
```

然后在 GitHub 网页上：
1. Releases → Draft a new release
2. Tag 填 `0.1.1`（创建新 tag）
3. 上传 `release\dsh-obsidian-0.1.1.zip`
4. 发布

## 四、提交官方社区商店（审核制，可选）

1. Fork [obsidian-releases](https://github.com/obsidianmd/obsidian-releases) 仓库
2. 在 `community-plugins.json` 的列表末尾添加：
   ```json
   {
     "id": "dsh-obsidian",
     "name": "DSH for Obsidian",
     "author": "moozhu",
     "description": "Embed DeepSeek Harness Web UI in Obsidian, with one isolated workspace per vault.",
     "repo": "moozhu/dsh-obsidian"
   }
   ```
3. 发 PR。首次发布需在 PR 说明里注明：**本插件依赖外部程序 Node.js**（与 opencode-obsidian 同类），插件会自动检测并引导安装
4. 审核通过后，商店安装 + 自动更新（走最新 Release 的 zip + versions.json）

## 版本号规则

- 每次发版递增 `manifest.json` 的 `version`（semver）
- 同时在 `versions.json` 增加 `"x.y.z": "1.4.0"` 条目（后值是 minAppVersion）
- 一条命令搞定：`.\release.ps1 -Version x.y.z`
