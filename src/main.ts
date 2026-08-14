import {
  addIcon,
  App,
  FileSystemAdapter,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { get } from "http";
import { homedir } from "os";
import { basename, dirname, join } from "path";

/**
 * DSH 实例管理 + 设置模型。
 * 设计：每库（vault）一个独立 DSH 实例，端口按库路径确定性分配；
 * 以后要加"所有库共享一个实例"模式时，只需在这里改解析策略，UI 层不动。
 *
 * 引用 = 纯复制：选中内容/文件路径写入剪贴板即完成，不做任何其他动作
 * （跨源 iframe 无法可靠地自动聚焦输入框，自动粘贴方案已放弃）。
 * 用户到 DSH 输入框 Ctrl+V 粘贴，自己组织需求后再发送。
 *
 * 注意：整个插件刻意保持单文件编译（tsc → 单一 main.js），
 * 因为 Obsidian 的插件加载器只保证单文件 main.js 的加载，
 * 相对路径 require 多文件在部分版本会报 "Failed to load plugin"。
 */

interface InstanceRecord {
  port: number;
  pid?: number;
}

interface DshSettings {
  /** dsh 可执行文件完整路径；留空 = 自动探测 */
  dshCommand: string;
  /** 端口池起点（每个库一个端口，从此往上找空闲） */
  basePort: number;
  /** 打开 Obsidian 时自动启动当前库实例并打开面板 */
  autoStart: boolean;
  /** 关闭 Obsidian 时停止实例进程 */
  stopOnUnload: boolean;
  /** DSH 面板位置 */
  viewLocation: "right-sidebar" | "left-sidebar" | "tab";
  /** vaultPath -> 实例记录（端口/pid），持久化在插件 data.json */
  instances: Record<string, InstanceRecord>;
}

const DEFAULT_SETTINGS: DshSettings = {
  dshCommand: "",
  basePort: 3090,
  autoStart: false,
  stopOnUnload: true,
  viewLocation: "right-sidebar",
  instances: {},
};

/** 启动错误：nodeMissing 时面板额外展示 Node.js 下载入口。 */
class BootError extends Error {
  constructor(message: string, public nodeMissing = false) {
    super(message);
  }
}

//#region 探测

/**
 * 探测本地端口上的 HTTP 服务。
 * @param checkBody 为空表示"有任何响应即占用"；否则校验响应体。
 */
function httpProbe(
  port: number,
  timeoutMs: number,
  checkBody: ((body: string) => boolean) | null
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(
      { host: "127.0.0.1", port, path: "/", timeout: timeoutMs },
      (res) => {
        if (!checkBody) {
          req.destroy();
          resolve(true);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            req.destroy();
            resolve(checkBody(body));
          }
        });
        res.on("end", () => resolve(checkBody(body)));
        res.on("error", () => resolve(false));
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 端口上是否有任何 HTTP 服务（用于空闲端口判定）。 */
function probeAnyHttp(port: number, timeoutMs = 2000): Promise<boolean> {
  return httpProbe(port, timeoutMs, null);
}

/** 端口上是否有一个可识别的 DSH 实例（响应体含品牌特征）。 */
function probeDsh(port: number, timeoutMs = 3000): Promise<boolean> {
  return httpProbe(port, timeoutMs, (body) => body.includes("DeepSeek Harness"));
}

/** 轮询等待 DSH 就绪。 */
async function waitForDsh(port: number, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeDsh(port)) return;
    if (Date.now() > deadline) {
      throw new Error(`DSH 启动超时（端口 ${port}），请检查 Node.js 是否安装、路径设置是否正确`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 探测 Node.js 是否可用（npx 依赖它）。 */
function probeNode(timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("node --version", {
      shell: true,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

//#endregion

//#region 可执行文件探测

/**
 * 自动探测 dsh 可执行文件（Windows）：
 * 1. npm 全局安装 %APPDATA%\npm\dsh.cmd
 * 2. npx 缓存 %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\.bin\dsh.cmd
 * 都找不到返回 null。
 */
function detectDshCommand(): string | null {
  const candidates: string[] = [];
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  candidates.push(join(appData, "npm", "dsh.cmd"));

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const npxRoot = join(localAppData, "npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    try {
      for (const sub of readdirSync(npxRoot)) {
        candidates.push(join(npxRoot, sub, "node_modules", ".bin", "dsh.cmd"));
      }
    } catch {
      // 目录不可读时忽略，走下一个候选
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

//#endregion

//#region 库专属数据目录（DSH_HOME 隔离）

/**
 * 每个库一个独立的 DSH 数据目录：
 * - 新实例里没有"别的已注册工作区"可被默认选中，DSH 新建会话时
 *   cwd 直接落到进程启动目录（= 库路径），天然跟库挂钩；
 * - 会话历史按库彻底隔离，库之间、库与桌面版实例互不干扰。
 */
function hashPath(path: string): number {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 库专属 DSH_HOME：%LOCALAPPDATA%\dsh-obsidian\<hash>（不污染库、不参与 OneDrive 同步）。 */
function vaultHome(vaultPath: string): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "dsh-obsidian", hashPath(vaultPath).toString(16));
}

/**
 * 首次启动时把主 .dsh 的凭据和设置继承到库专属目录，
 * 免去每个库重复配置 API 密钥与搜索网关。
 */
function inheritMainConfig(vaultHomePath: string): void {
  if (existsSync(join(vaultHomePath, "settings.yaml"))) return; // 已初始化过，不覆盖
  const mainHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  mkdirSync(vaultHomePath, { recursive: true });
  for (const file of [".credentials.yaml", "settings.yaml"]) {
    const source = join(mainHome, file);
    if (existsSync(source)) {
      try {
        copyFileSync(source, join(vaultHomePath, file));
      } catch {
        // 继承失败不阻塞启动，用户可在库实例里手动配置
      }
    }
  }
}

interface WorkspaceStorage {
  unit: { name: string; version: number };
  global: { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] };
  tables: { workspaces: Record<string, unknown> };
}

/**
 * 把库根注册为库专属数据目录里的工作区，让 DSH 打开时默认选中它
 * （DSH 会默认选中列表中的工作区；库根是唯一项，天然被选中）。
 * 只在实例启动前写入；已存在工作区则不动，避免覆盖用户后续添加的工作区。
 */
function seedWorkspace(vaultHomePath: string, vaultPath: string): void {
  const storageFile = join(vaultHomePath, "storages", "workspace.json");
  let canonical: string;
  try {
    canonical = realpathSync(vaultPath);
  } catch {
    return; // 库路径解析失败就不种，交给用户手动选择
  }

  let data: WorkspaceStorage | null = null;

  if (existsSync(storageFile)) {
    try {
      const parsed = JSON.parse(readFileSync(storageFile, "utf8")) as WorkspaceStorage;
      const existing = parsed?.tables?.workspaces ?? {};
      if (Object.keys(existing).length > 0) return; // 已有工作区，不注入
      data = parsed;
    } catch {
      data = null; // 文件损坏，重建
    }
  }

  if (data === null) {
    data = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  data.global.workspaceIds = [...(data.global.workspaceIds ?? []), id];
  data.tables.workspaces[id] = {
    path: canonical,
    title: basename(canonical),
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };

  try {
    mkdirSync(dirname(storageFile), { recursive: true });
    writeFileSync(storageFile, JSON.stringify(data), "utf8");
  } catch {
    // 写入失败不阻塞启动，用户可手动选择工作区
  }
}

//#endregion

//#region 进程管理

/** 生成启动命令：优先本地 dsh 绝对路径；都没有则回退 npx 在线安装。 */
function resolveBootCommand(settings: DshSettings, port: number): string {
  const custom = settings.dshCommand.trim();
  if (custom) return `"${custom}" web --port ${port}`;
  const detected = detectDshCommand();
  if (detected) return `"${detected}" web --port ${port}`;
  return `npx --yes @deepseek-ai/dsh web --port ${port}`;
}

/** 启动 DSH 子进程（cwd = 库根目录，DSH_HOME = 库专属数据目录），返回 pid。 */
function spawnDsh(bootCommand: string, vaultPath: string): number | undefined {
  const child = spawn(bootCommand, {
    shell: true,
    cwd: vaultPath,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      DSH_HOME: vaultHome(vaultPath),
    },
  });
  child.on("error", () => {
    // 启动失败（如 npx 不存在）由就绪轮询超时兜底提示
  });
  child.unref();
  return child.pid;
}

/** 停止进程及其子进程树。 */
function stopProcess(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

//#endregion

/**
 * 实例解析层：负责"哪个库 -> 哪个端口/实例"。
 * 每库一实例策略：vaultPath 哈希映射到端口，冲突上移；
 * 之后若要做共享单实例模式，新增一个策略类即可（UI/视图无需改动）。
 */
class InstanceManager {
  constructor(
    private getSettings: () => DshSettings,
    private save: () => Promise<void>
  ) {}

  /** 库路径的确定性候选端口。 */
  vaultPort(vaultPath: string): number {
    return this.getSettings().basePort + (hashPath(vaultPath) % 200);
  }

  /**
   * 确保当前库的 DSH 实例在运行，返回其端口。
   * 已运行（端口上可识别出 DSH）则直接复用，不重复启动。
   */
  async ensureRunning(
    vaultPath: string,
    onState?: (state: string) => void
  ): Promise<number> {
    const settings = this.getSettings();
    const record = settings.instances[vaultPath];

    // 1. 复用：之前记录过且端口上确实有 DSH 在响应
    if (record && (await probeDsh(record.port))) {
      onState?.(`运行中 @ ${record.port}`);
      return record.port;
    }

    // 2. 前置检查：Node.js（npx 依赖）
    if (!(await probeNode())) {
      throw new BootError("未检测到 Node.js（DSH 依赖它运行）", true);
    }

    // 3. 分配空闲端口：从确定性候选开始往上找
    let port = this.vaultPort(vaultPath);
    for (let i = 0; i < 100; i++) {
      if (!(await probeAnyHttp(port))) break;
      port++;
    }

    // 4. 准备库专属数据目录（首次继承主配置 + 种入库根工作区），启动 + 等待就绪
    const bootCommand = resolveBootCommand(settings, port);
    inheritMainConfig(vaultHome(vaultPath));
    seedWorkspace(vaultHome(vaultPath), vaultPath);
    onState?.(`正在启动 @ ${port} ...`);
    const pid = spawnDsh(bootCommand, vaultPath);
    await waitForDsh(port);

    settings.instances[vaultPath] = { port, pid };
    await this.save();
    onState?.(`运行中 @ ${port}`);
    return port;
  }

  /** 停止所有已记录的实例。 */
  stopAll(): void {
    const records = Object.values(this.getSettings().instances);
    for (const record of records) {
      if (record.pid) stopProcess(record.pid);
    }
  }
}

//#region Obsidian 插件主体

const VIEW_TYPE = "dsh-view";

/** DeepSeek 官方鲸鱼 logo（取自 DSH webui 的 favicon.svg，50x50 坐标系的 path 数据）。 */
const FISH_LOGO_PATH_D =
  "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";

/** DSH 面板视图：一个 iframe 嵌 DSH Web UI。 */
class DshView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: DshPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DSH";
  }

  getIcon(): string {
    return "dsh-logo";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("dsh-view");

    const status = this.contentEl.createDiv({ cls: "dsh-status" });
    status.setText("正在启动 DSH ...");

    const vaultPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();

    try {
      const port = await this.plugin.manager.ensureRunning(vaultPath, (state) => {
        status.setText(state);
        this.plugin.updateStatusBar(state);
      });
      status.remove();

      const frame = this.contentEl.createEl("iframe", { cls: "dsh-frame" });
      frame.setAttr("src", `http://127.0.0.1:${port}/`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.setText(`启动失败：${message}`);
      if (error instanceof BootError && error.nodeMissing) {
        const link = status.createEl("a", {
          text: "下载 Node.js（nodejs.org/zh-cn）",
          href: "https://nodejs.org/zh-cn",
        });
        link.setAttr("target", "_blank");
        link.setAttr("rel", "noopener");
        status.createEl("div", { text: "安装后重新打开面板即可。" });
      }
      this.plugin.updateStatusBar("启动失败");
      new Notice(`DSH 启动失败：${message}`, 10000);
    }
  }
}

export default class DshPlugin extends Plugin {
  declare settings: DshSettings;
  manager!: InstanceManager;
  private statusBar!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.manager = new InstanceManager(
      () => this.settings,
      () => this.saveSettings()
    );

    this.registerView(VIEW_TYPE, (leaf) => new DshView(leaf, this));

    // 注册 DeepSeek 鲸鱼 logo 图标（addIcon 是 Obsidian 自定义图标的正确姿势：
    // 传入 svg 内部内容字符串，容器自动套 100x100 viewBox，path 坐标是 50x50，放大 2 倍适配）
    addIcon(
      "dsh-logo",
      `<path d="${FISH_LOGO_PATH_D}" fill="currentColor" transform="scale(2)"/>`
    );

    this.addRibbonIcon("dsh-logo", "打开 DSH", () => {
      void this.openView();
    });

    this.addCommand({
      id: "open-dsh",
      name: "打开 DSH 面板",
      callback: () => {
        void this.openView();
      },
    });

    this.addSettingTab(new DshSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.updateStatusBar("已停止");

    if (this.settings.autoStart) void this.openView();
  }

  /** 打开（或聚焦）DSH 面板。 */
  async openView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    let leaf: WorkspaceLeaf | null = existing ?? null;
    if (!leaf) {
      leaf =
        this.settings.viewLocation === "tab"
          ? workspace.getLeaf("tab")
          : this.settings.viewLocation === "left-sidebar"
            ? workspace.getLeftLeaf(false)
            : workspace.getRightLeaf(false);
    }
    if (!leaf) {
      new Notice("无法创建 DSH 面板，请尝试重启 Obsidian");
      return;
    }
    if (!existing) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  updateStatusBar(text: string): void {
    if (this.statusBar) this.statusBar.setText(`DSH: ${text}`);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    if (this.settings.stopOnUnload) this.manager.stopAll();
  }
}

class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "DSH for Obsidian" });
    containerEl.createEl("p", {
      text: "在 Obsidian 中嵌入 DeepSeek Harness Web UI，按库（vault）管理独立的工作区与会话。",
    });

    new Setting(containerEl)
      .setName("dsh 可执行文件路径")
      .setDesc(
        "留空则自动探测（npm 全局安装 → npx 缓存 → 在线 npx 安装）。" +
          "自动探测失败时请手动填写完整路径，例如 C:\\Users\\你的用户名\\AppData\\Roaming\\npm\\dsh.cmd"
      )
      .addText((text) =>
        text
          .setPlaceholder(detectDshCommand() ?? "自动探测 / npx 在线安装")
          .setValue(this.plugin.settings.dshCommand)
          .onChange(async (value) => {
            this.plugin.settings.dshCommand = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("基础端口")
      .setDesc(
        "每个库占用一个端口（从基础端口往上找空闲）。默认 3090，避开桌面版 DSH 常用的 3080。"
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.basePort))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
              this.plugin.settings.basePort = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("打开 Obsidian 时自动启动")
      .setDesc("开启后，每次打开 Obsidian 会自动拉起当前库的 DSH 实例并打开面板。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("关闭 Obsidian 时停止实例")
      .setDesc("关闭后自动停止 DSH 进程以释放内存；关闭此选项则实例常驻后台，下次秒开。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.stopOnUnload).onChange(async (value) => {
          this.plugin.settings.stopOnUnload = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("面板位置")
      .setDesc("DSH 面板显示的位置。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("right-sidebar", "右侧边栏")
          .addOption("left-sidebar", "左侧边栏")
          .addOption("tab", "新标签页")
          .setValue(this.plugin.settings.viewLocation)
          .onChange(async (value) => {
            this.plugin.settings.viewLocation = value as DshSettings["viewLocation"];
            await this.plugin.saveSettings();
          })
      );
  }
}

//#endregion
