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
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { get } from "http";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { parseDocument, Document } from "yaml";

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
  /** dsh web 打印的接入 URL（alpha 鉴权时含 ?token=） */
  url?: string;
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
  /** 上次后台版本检查时间戳（24h 节流） */
  lastUpdateCheck: number;
  /** 数据备份目录；留空 = 默认 %LOCALAPPDATA%\dsh-obsidian\<库Hash>\backups */
  backupDir: string;
}

const DEFAULT_SETTINGS: DshSettings = {
  dshCommand: "",
  basePort: 3090,
  autoStart: false,
  stopOnUnload: true,
  viewLocation: "right-sidebar",
  instances: {},
  lastUpdateCheck: 0,
  backupDir: "",
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

/**
 * URL 有效性三态探测（复用判定用）：
 * - ok：服务健康，记录里的 URL 仍可直接加载；
 * - unauthorized：服务活着但 URL 凭证已失效（典型：记录是 rc 时代无 token 的 URL，端口上已换成需要 token 的 alpha）；
 * - fail：不可达 / 半死服务。
 */
function probeUrl(url: string, timeoutMs = 3000): Promise<"ok" | "unauthorized" | "fail"> {
  return new Promise((resolve) => {
    const req = get(url, (res) => {
      const sc = res.statusCode ?? 0;
      res.resume();
      resolve(sc === 401 || sc === 403 ? "unauthorized" : "ok");
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve("fail");
    });
    req.on("error", () => resolve("fail"));
  });
}

/** 杀掉占用指定端口的监听进程（复用判定失败后清理旧实例，避免它继续占端口）。 */
function killPortOwner(port: number): void {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 10_000 }
    );
  } catch {
    // 清理失败不阻塞重启流程
  }
}

/** 从 dsh 的 stdout 里解析它自宣的 Web 地址（rc 无 token，alpha 带 ?token=）。 */
function parseWebUrl(log: string): string | null {
  const m = /dsh web:\s+(https?:\/\/[^\s]+)/.exec(log);
  return m ? m[1] : null;
}

/**
 * 轮询等待 DSH 就绪：优先以 dsh 自己打印的 URL 为准（一套逻辑同时兼容 rc 与 alpha 的鉴权差异）。
 * 拿不到 URL（如 printUrl 被关闭）时回退为「端口上有 HTTP 服务即可」，url 为空由调用方兜底。
 */
async function waitForDsh(
  port: number,
  timeoutMs = 120000,
  getLog: () => string = () => ""
): Promise<{ url: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = parseWebUrl(getLog());
    if (url) return { url };
    const alive = await probeAnyHttp(port, 1500);
    if (Date.now() > deadline) {
      if (alive) return { url: null };
      throw new Error(`DSH 启动超时（端口 ${port}），请检查 Node.js 是否安装、路径设置是否正确`);
    }
    await new Promise((r) => window.setTimeout(r, 500));
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
    const timer = window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      window.clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      window.clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

//#endregion

//#region 可执行文件探测

interface DshInstall {
  cmd: string;
  version: string | null;
}

/** 后台更新目录：检查到新版时装到这里，与全局/npx 缓存并列参与版本择优。 */
function managedDshDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "dsh-obsidian", "dsh-latest");
}

function readDshVersion(pkgJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 枚举所有本地 dsh 副本及版本，优先级顺序：
 * npm 全局安装 → 管理目录（后台更新）→ npx 缓存各哈希/手动目录。
 */
function detectDshInstalls(): DshInstall[] {
  const installs: DshInstall[] = [];
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

  const globalCmd = join(appData, "npm", "dsh.cmd");
  if (existsSync(globalCmd)) {
    installs.push({
      cmd: globalCmd,
      version: readDshVersion(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json")),
    });
  }

  const managedRoot = managedDshDir();
  const managedCmd = join(managedRoot, "node_modules", ".bin", "dsh.cmd");
  if (existsSync(managedCmd)) {
    installs.push({
      cmd: managedCmd,
      version: readDshVersion(join(managedRoot, "node_modules", "@deepseek-ai", "dsh", "package.json")),
    });
  }

  const npxRoot = join(localAppData, "npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    try {
      for (const sub of readdirSync(npxRoot)) {
        const root = join(npxRoot, sub);
        const cmd = join(root, "node_modules", ".bin", "dsh.cmd");
        if (existsSync(cmd)) {
          installs.push({
            cmd,
            version: readDshVersion(join(root, "node_modules", "@deepseek-ai", "dsh", "package.json")),
          });
        }
      }
    } catch {
      // 目录不可读时忽略
    }
  }

  // PATH 中的全局 dsh（覆盖 npm 全局之外的安装方式，如 pnpm / 手动全局链接）。
  // 之前这类安装探测不到，插件会误以为"本地没装过"而走 npx 在线下载，白白等一次冷安装。
  try {
    const out = execFileSync("cmd.exe", ["/d", "/s", "/c", "where dsh"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 5_000,
    });
    for (const line of out.split(/\r?\n/)) {
      const cmd = line.trim();
      if (!cmd || !cmd.toLowerCase().endsWith(".cmd")) continue;
      if (installs.some((i) => i.cmd.toLowerCase() === cmd.toLowerCase())) continue;
      const root = dirname(dirname(cmd)); // <root>\node_modules\.bin\dsh.cmd → <root>
      const pkg = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
      if (!existsSync(pkg)) continue;
      installs.push({ cmd, version: readDshVersion(pkg) });
    }
  } catch {
    // where 失败 = PATH 里没有 dsh
  }

  return installs;
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string[] } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** semver 比较（含 -rc.x 预发布：正式版 > 预发布）。无法解析视为相等。 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const xa = pa.pre[i];
    const xb = pb.pre[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/** 版本最高者胜；版本缺失让位于有版本者；同版本按探测优先级（先出现者）。 */
function pickBestInstall(installs: DshInstall[]): DshInstall | null {
  let best: DshInstall | null = null;
  for (const cur of installs) {
    if (!best) {
      best = cur;
      continue;
    }
    if (cur.version && !best.version) {
      best = cur;
      continue;
    }
    if (cur.version && best.version && compareSemver(cur.version, best.version) > 0) {
      best = cur;
    }
  }
  return best;
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
 * 从主 .dsh 单向同步"模型基础设施"配置到库专属目录。
 *
 * 设计取舍（为什么单向、只同步模型供应商与凭据）：
 * - 只同步"基础设施"：模型供应商（LLM provider 路由：baseURL、模型列表、兼容配置等）
 *   和 API 凭据。这些是配置一次就该处处可用的东西——在主实例（如桌面版 3080）
 *   添加一个供应商 / API key 后，各库的 DSH 也能直接用，不必每个库重复配置。
 * - **不同步默认模型路由（agent-default-model）与搜索模型（web-search-deepseek）**：
 *   每个库想用哪个模型作为默认（如主实例用 deepseek、某库用 gpt/mimo）是库自己的
 *   选择，不应被主实例覆盖。
 * - 对 provider 这类字典采用"合并（union）"而非"整体替换"：主实例有、库没有的
 *   会被补进来；库实例单独添加的 provider/凭据予以保留；同名项以主为准覆盖。
 *   这样既同步了新增，又不会误删任一实例里特有的配置。
 * - 方向固定为 主 → 库 单向：主实例是模型配置的权威源。库实例里的模型改动
 *   不会回写主实例（避免多端互相覆盖造成混乱；这一取舍写入 README）。
 * - 插件体系（profiles 目录）不在此同步范围内：不同库想用不同插件时互不干扰。
 *
 * 该函数在每次启动实例前调用，因此在主实例新增供应商/密钥后，重启/重开任一库面板即可同步。
 */
function syncModelConfig(vaultHomePath: string): void {
  const mainHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  mkdirSync(vaultHomePath, { recursive: true });

  // 1) 凭据：并集合并（主新增的 key 补进库，库独有的 key 保留，同名以主覆盖）。
  const mainCred = join(mainHome, ".credentials.yaml");
  const vaultCred = join(vaultHomePath, ".credentials.yaml");
  if (existsSync(mainCred)) {
    try {
      const mergedCred = mergeYamlFile(mainCred, vaultCred);
      // dsh 凭据只认 version / refs / records 三个顶层键；
      // 老式扁平键（如 DEEPSEEK_API_KEY）会导致 vault 实例启动崩溃，必须剔除。
      const sanitized = sanitizeCredentialKeys(mergedCred);
      writeFileSync(vaultCred, sanitized, "utf8");
    } catch {
      // 凭证同步失败不阻塞启动，用户可在库实例里手动配置
    }
  }

  // 2) 设置：只把白名单内的"模型供应商"命名空间以主为准合并进库的 settings.yaml，
  //    保留库实例里其它命名空间、独有 provider 与默认模型选择。
  const MODEL_NAMESPACES = ["llm-pi-ai", "llm-deepseek"] as const;

  const mainSettings = join(mainHome, "settings.yaml");
  const vaultSettings = join(vaultHomePath, "settings.yaml");
  if (!existsSync(mainSettings)) return; // 主实例没有设置可同步

  let mainDoc: Document;
  try {
    mainDoc = parseDocument(readFileSync(mainSettings, "utf8"));
    if (mainDoc.errors.length > 0 || mainDoc.toJS() == null) return;
  } catch {
    return; // 主设置解析失败就跳过，保留库现有配置
  }

  const vaultDoc = existsSync(vaultSettings) ? parseDocument(readFileSync(vaultSettings, "utf8")) : new Document({});
  const mainRoot = mainDoc.toJS() as Record<string, unknown> | null;
  const vaultRoot = vaultDoc.toJS() as Record<string, unknown> | null;
  if (mainRoot == null) return;

  let changed = false;
  for (const ns of MODEL_NAMESPACES) {
    const mainVal = mainRoot[ns]; // 主命名空间的纯 JS 值
    if (mainVal === undefined) continue;
    const vaultVal = vaultRoot?.[ns];
    const merged = mergeModelSection(vaultVal, mainVal); // 主优先覆盖，库独有保留
    vaultDoc.setIn([ns], merged);
    changed = true;
  }
  if (changed) {
    try {
      writeFileSync(vaultSettings, vaultDoc.toString({}), "utf8");
    } catch {
      // 写入失败不阻塞启动
    }
  }
}

/**
 * 合并两个 YAML 文件：以 source 为准覆盖 target，但对纯对象做逐键合并，
 * 保留 target 里 source 没有的键。source 文件不存在时返回 target 原内容；
 * target 不存在时返回 source 序列化结果。
 */
function mergeYamlFile(sourcePath: string, targetPath: string): string {
  const sourceDoc = parseDocument(readFileSync(sourcePath, "utf8"));
  if (sourceDoc.errors.length > 0) {
    // 源文件损坏则保留目标文件现状
    return existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  }
  if (!existsSync(targetPath)) return sourceDoc.toString({});
  const targetDoc = parseDocument(readFileSync(targetPath, "utf8"));
  const sourceRoot = sourceDoc.toJS() as Record<string, unknown> | null;
  const targetRoot = targetDoc.toJS() as Record<string, unknown> | null;
  if (
    sourceRoot !== null &&
    typeof sourceRoot === "object" &&
    !Array.isArray(sourceRoot) &&
    targetRoot !== null &&
    typeof targetRoot === "object" &&
    !Array.isArray(targetRoot)
  ) {
    const merged = mergeModelSection(targetRoot, sourceRoot);
    targetDoc.setIn([], merged);
    return targetDoc.toString({});
  }
  return sourceDoc.toString({});
}

/**
 * 只保留 dsh 凭据允许的顶层键（version / refs / records），
 * 丢弃其它（如老式扁平 DEEPSEEK_API_KEY），避免 vault 实例启动崩溃。
 * dsh-credentials-local 的校验器（lib/index.js）只允许这三个顶层键。
 */
function sanitizeCredentialKeys(yamlStr: string): string {
  let doc: Document;
  try {
    doc = parseDocument(yamlStr);
  } catch {
    return yamlStr;
  }
  if (doc.errors.length > 0) return yamlStr;
  const ALLOWED = new Set(["version", "refs", "records"]);
  const root = doc.toJS() as Record<string, unknown> | null;
  if (root === null || typeof root !== "object" || Array.isArray(root)) return yamlStr;
  for (const key of Object.keys(root)) {
    if (!ALLOWED.has(key)) doc.delete(key);
  }
  return doc.toString({});
}

/**
 * 深度合并一个模型命名空间：以 source(main) 为准覆盖 target(vault)，
 * 但对纯对象做逐键合并，保留 target 里 source 没有的键（如库独有的 provider/模型）。
 * 数组与标量整体以 source 为准替换。
 */
function mergeModelSection(target: unknown, source: unknown): unknown {
  if (isPlainObject(target) && isPlainObject(source)) {
    const out: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(source)) {
      out[key] = mergeModelSection(out[key], value);
    }
    return out;
  }
  return source; // 非对象（标量/数组/缺失）整体以主为准
}

/** 是否是普通对象（非 null、非数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkspaceStorage {
  unit: { name: string; version: number };
  globalState: { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] };
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
      globalState: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  data.globalState.workspaceIds = [...(data.globalState.workspaceIds ?? []), id];
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

/** 目标 dsh 版本是否启用浏览器鉴权（0.1.2 起，含 0.1.2-alpha.x 与未来正式版）。 */
function needsAuthVersion(version: string | null): boolean {
  if (!version) return false;
  // 0.1.2 及更高（含 0.1.2-alpha.x/rc.x 等预发布）启用浏览器鉴权 + 投影缓存 schema 迁移。
  // 注意不能用 compareSemver(version,"0.1.2")>=0：它把 0.1.2-alpha.3 判为小于 0.1.2，
  // 导致 alpha 永远不会被识别为"需迁移"。这里只比较主版本号段，忽略预发布后缀。
  const p = parseSemver(version);
  if (!p) return false;
  const [maj, min, patch] = p.nums;
  return maj > 0 || (maj === 0 && (min > 1 || (min === 1 && patch >= 2)));
}

/**
 * 把 rc 写的 session 投影缓存原地升级为 0.1.2+（浏览器鉴权版）可读的 schema：
 * 每个 session 的 identity 补 isSeeded=false 与 inheritedEventCount=0（幂等）。
 *
 * dsh-storage 存在两种布局，都必须迁移：
 * 1. 单文件（旧布局）：storages/session_projcache.json
 *    结构 { unit, global, tables: { <table>: { <key>: { identity, rows } } } }
 * 2. 分片（新布局）：storages/session_projcache/<table>/<key>.json
 *    结构 { version: n, record: { identity, rows } }
 * 实测 0.1.2-alpha.3 读的是分片布局——若只补单文件、漏掉分片，启动仍会
 * invalid-record 崩溃（identity.isSeeded / inheritedEventCount 缺失）。
 *
 * 迁移前先把所有将被改动的文件备份到 backupDir（带时间戳），备份失败则放弃迁移。
 */
function migrateSessionProjectionCache(vaultHomePath: string, backupDir: string): void {
  const storagesDir = join(vaultHomePath, "storages");
  if (!existsSync(storagesDir)) return;

  const rewrites: Array<{ file: string; data: unknown }> = [];

  // 1. 单文件布局
  const single = join(storagesDir, "session_projcache.json");
  if (existsSync(single)) {
    let data: { tables?: Record<string, Record<string, { identity?: Record<string, unknown> }>> } | null;
    try {
      data = JSON.parse(readFileSync(single, "utf8"));
    } catch {
      data = null; // 文件损坏，交给 dsh 自行兜底
    }
    if (data?.tables) {
      let changed = 0;
      for (const tableName of Object.keys(data.tables)) {
        const records = data.tables[tableName];
        if (!records) continue;
        for (const key of Object.keys(records)) {
          changed += patchIdentity(records[key]);
        }
      }
      if (changed > 0) rewrites.push({ file: single, data });
    }
  }

  // 2. 分片布局
  const shardRoot = join(storagesDir, "session_projcache");
  if (existsSync(shardRoot)) {
    let tableNames: string[] = [];
    try {
      tableNames = readdirSync(shardRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      tableNames = [];
    }
    for (const tableName of tableNames) {
      const tablePath = join(shardRoot, tableName);
      let files: string[] = [];
      try {
        files = readdirSync(tablePath).filter((f) => f.endsWith(".json"));
      } catch {
        files = [];
      }
      for (const f of files) {
        const file = join(tablePath, f);
        let data: { record?: { identity?: Record<string, unknown> } } | null;
        try {
          data = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          data = null;
        }
        if (!data?.record) continue;
        const changed = patchIdentity(data.record);
        if (changed > 0) rewrites.push({ file, data });
      }
    }
  }

  if (rewrites.length === 0) return; // 已是最新 schema 或无需迁移

  // 先备份、后写回；备份失败则放弃本次迁移，避免无备份就改动数据
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  let backedUp = true;
  try {
    mkdirSync(backupDir, { recursive: true });
    for (const r of rewrites) {
      copyFileSync(r.file, join(backupDir, `session_projcache.rc.${ts}.${basename(r.file)}`));
    }
  } catch {
    backedUp = false;
  }
  if (!backedUp) return;
  for (const r of rewrites) {
    try {
      writeFileSync(r.file, JSON.stringify(r.data), "utf8");
    } catch {
      // 单个写回失败不阻塞启动，dsh 会用（或重建）存储
    }
  }
}

/** 补一个 record 的 identity 缺失字段（isSeeded/inheritedEventCount），返回改动条数（0/1/2）。 */
function patchIdentity(rec: { identity?: Record<string, unknown> } | undefined | null): number {
  if (!rec || typeof rec !== "object") return 0;
  if (!rec.identity || typeof rec.identity !== "object") rec.identity = {};
  let changed = 0;
  if (rec.identity.isSeeded === undefined) {
    rec.identity.isSeeded = false;
    changed++;
  }
  if (rec.identity.inheritedEventCount === undefined) {
    rec.identity.inheritedEventCount = 0;
    changed++;
  }
  return changed;
}

//#endregion

//#region 进程管理

/**
 * 生成启动命令：
 * 1. 用户手动填了 dsh 路径 → 锁定用该版本（不自动升级）
 * 2. 否则本地缓存（npm 全局 / npx 缓存）优先：秒级启动、离线可用
 * 3. 无本地缓存时才 npx --yes 在线安装
 *
 * 本地优先的原因：npx 冷安装要实时拉取整棵依赖树，慢网络下耗时可达数分钟
 * 且默认日志级别下无任何输出；若把 npx 放在 `A || B` 的 A 位，"挂起"不等于
 * "失败"，本地兜底永远没机会执行，表现为启动超时无输出。
 * npx 对已缓存的包本就不会主动检查更新，因此本地优先不损失自动升级能力。
 */
function resolveBootCommand(
  settings: DshSettings,
  port: number
): { command: string; npxOnly: boolean; version: string | null } {
  const custom = settings.dshCommand.trim();
  if (custom) return { command: `"${custom}" web --port ${port} --no-open`, npxOnly: false, version: null };
  const best = pickBestInstall(detectDshInstalls());
  if (best) {
    return { command: `"${best.cmd}" web --port ${port} --no-open`, npxOnly: false, version: best.version };
  }
  return { command: `npx --yes @deepseek-ai/dsh web --port ${port} --no-open`, npxOnly: true, version: null };
}

/**
 * 启动 DSH 子进程（cwd = 库根目录，DSH_HOME = 库专属数据目录）。
 * 关键修正：不再用 stdio:"ignore" 吞掉输出，而是捕获 stdout/stderr，
 * 这样启动失败时（端口被占、依赖缺失、npx 拉取失败等）能在面板里看到真实报错，
 * 而不是只得到一个笼统的"超时"。返回的 ChildProcess 上挂了 __getLog() 供超时兜底读取。
 */
function spawnDsh(bootCommand: string, vaultPath: string): ChildProcess | undefined {
  const child = spawn(bootCommand, {
    shell: true,
    cwd: vaultPath,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DSH_HOME: vaultHome(vaultPath),
    },
  });
  let log = "";
  const collect = (d: Buffer | string) => {
    log += d.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (err) => {
    log += `\n[spawn error] ${err.message}`;
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      log += `\n[dsh exited code=${code}${signal ? ` signal=${signal}` : ""}]`;
    }
  });
  (child as unknown as { __getLog: () => string }).__getLog = () => log;
  child.unref();
  return child;
}

/** 停止进程及其子进程树。 */
function stopProcess(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

//#endregion

//#region 后台版本检查与更新

function runNpm(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(`npm ${args.join(" ")}`, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer | string) => (out += d.toString()));
    const timer = window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      resolve(null);
    }, timeoutMs);
    child.on("error", () => {
      window.clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      window.clearTimeout(timer);
      resolve(code === 0 ? out.trim() : null);
    });
  });
}

/** 内核版本通道：stable = npm latest（官方正式通道），alpha = npm alpha（预览通道）。 */
type DshChannel = "stable" | "alpha";

/** npm 镜像 registry（官方源被墙/不稳时的兜底，大陆网络下载更稳）。 */
const NPM_MIRROR_REGISTRY = "https://registry.npmmirror.com";

/**
 * 按通道查询 registry 最新版。先走用户 npm 配置（代理/镜像）；
 * 配置链路失败（如本地代理软件没启动，连接挂死）时直连兜底；
 * 直连仍失败时切 npmmirror 镜像 registry 兜底。
 */
async function fetchChannelVersion(channel: DshChannel): Promise<string | null> {
  const tag = channel === "stable" ? "dist-tags.latest" : "dist-tags.alpha";
  const viaConfig = await runNpm(["view", "@deepseek-ai/dsh", tag], 15_000);
  if (viaConfig) return viaConfig;
  const direct = await runNpm(
    ["--proxy", "null", "--https-proxy", "null", "view", "@deepseek-ai/dsh", tag],
    15_000
  );
  if (direct) return direct;
  return runNpm(["--registry", NPM_MIRROR_REGISTRY, "view", "@deepseek-ai/dsh", tag], 15_000);
}

/** 后台安装 @latest 到临时目录，校验版本后提升为管理目录；失败不留半成品。 */
async function installLatestToManaged(latest: string): Promise<boolean> {
  const target = managedDshDir();
  const tmp = `${target}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "dsh-latest", private: true }), "utf8");
  const installArgs = [
    "install",
    "--prefix",
    `"${tmp}"`,
    `@deepseek-ai/dsh@${latest}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  const ok =
    (await runNpm(installArgs, 120_000)) !== null ||
    (await runNpm(["--proxy", "null", "--https-proxy", "null", ...installArgs], 600_000)) !== null ||
    (await runNpm(["--registry", NPM_MIRROR_REGISTRY, ...installArgs], 600_000)) !== null;
  const installedVersion = readDshVersion(join(tmp, "node_modules", "@deepseek-ai", "dsh", "package.json"));
  const valid = ok && installedVersion === latest && existsSync(join(tmp, "node_modules", ".bin", "dsh.cmd"));
  if (!valid) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 忽略
    }
    return false;
  }
  try {
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

type UpdateCheckResult =
  | { kind: "error" }
  | { kind: "up-to-date"; version: string; latest: string }
  | { kind: "update-available"; latest: string; current: string | null };

/**
 * 按通道只查询最新版（stable = npm latest 官方正式通道；alpha = npm alpha 预览通道）
 * 并与本地最高版本比较，绝不自动下载/安装。是否安装交由用户在设置页确认（决定权交给用户）。
 */
async function checkForUpdate(channel: DshChannel): Promise<UpdateCheckResult> {
  const latest = await fetchChannelVersion(channel);
  if (!latest) return { kind: "error" };
  const best = pickBestInstall(detectDshInstalls());
  if (best?.version && compareSemver(latest, best.version) <= 0) {
    return { kind: "up-to-date", version: best.version, latest };
  }
  return { kind: "update-available", latest, current: best?.version ?? null };
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
  ): Promise<{ port: number; url: string }> {
    const settings = this.getSettings();
    const record = settings.instances[vaultPath];

    // 0. 每次打开面板都同步主实例的模型供应商/凭据（无论实例是否已在运行）。
    //    运行中的 DSH 会在 settings.yaml 写回后热重载，下次请求即可用上新配置。
    syncModelConfig(vaultHome(vaultPath));

    // 1. 复用：记录过的 URL 仍然有效才复用。
    //    只探测端口会被"半死服务 / 换过内核"误导——典型事故：记录是 rc 时代无 token 的 URL，
    //    端口上已换成需要 token 的 alpha → 面板 401 空白。URL 有效才复用；
    //    401/403（凭证失效）或不可达 → 杀掉残留、重新启动拿新 URL（token 自动刷新）。
    if (record) {
      const recordedUrl = record.url ?? `http://127.0.0.1:${record.port}/`;
      const probe = await probeUrl(recordedUrl);
      if (probe === "ok") {
        onState?.(`运行中 @ ${record.port}`);
        return { port: record.port, url: recordedUrl };
      }
      if (await probeAnyHttp(record.port)) {
        // 端口上还有服务但 URL 无效：清掉旧实例，避免它继续占着端口
        killPortOwner(record.port);
      }
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

    // 4. 准备库专属数据目录（种入库根工作区），启动 + 等待就绪
    const { command: bootCommand, npxOnly, version } = resolveBootCommand(settings, port);
    const dshHome = vaultHome(vaultPath);
    if (needsAuthVersion(version)) {
      const backupDir = settings.backupDir.trim() || join(dshHome, "backups");
      migrateSessionProjectionCache(dshHome, backupDir);
    }
    seedWorkspace(dshHome, vaultPath);
    onState?.(
      npxOnly
        ? `正在下载安装 dsh 内核（首次在线安装，约需 1-5 分钟）...`
        : `正在启动 @ ${port} ...`
    );
    const child = spawnDsh(bootCommand, vaultPath);
    const pid = child?.pid;
    const getLog = () =>
      (child as unknown as { __getLog?: () => string } | undefined)?.__getLog?.() ?? "";
    // npx 冷安装期间周期刷新等待时长，面板不会像卡死一样毫无反馈
    const startAt = Date.now();
    let ticker: number | undefined;
    if (npxOnly) {
      ticker = window.setInterval(() => {
        const secs = Math.round((Date.now() - startAt) / 1000);
        onState?.(`正在下载安装 dsh 内核（已等待 ${secs}s，首次安装约需 1-5 分钟）...`);
      }, 10_000);
    }
    let url: string | null;
    try {
      // 超时统一 60 秒：本地副本十几秒就绪；npx 慢网装不完则快速失败并提示重试（npx 下载进度会保留）
      url = (await waitForDsh(port, 60_000, getLog)).url;
    } catch (e) {
      // 启动失败：杀掉残留子进程树，避免留下孤儿 dsh 占着端口（这也是反复超时的一大根因）
      if (child?.pid) stopProcess(child.pid);
      const log = getLog();
      const msg = e instanceof Error ? e.message : String(e);
      const hint = npxOnly
        ? "提示：首次在线安装下载较慢，可能未在 60 秒内完成——请重试一次（下载进度会保留），或检查网络后重试。"
        : "提示：可在终端进入库目录执行  npx --yes @deepseek-ai/dsh web --port <端口>  查看完整报错。";
      throw new Error(`${msg}\n\n--- dsh 启动输出（末尾 3000 字符）---\n${log.slice(-3000) || "（无输出）"}\n` + hint);
    } finally {
      if (ticker !== undefined) window.clearInterval(ticker);
    }

    const finalUrl = url ?? `http://127.0.0.1:${port}/`;
    settings.instances[vaultPath] = { port, pid, url: finalUrl };
    await this.save();
    onState?.(`运行中 @ ${port}`);
    return { port, url: finalUrl };
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
    await this.loadPanel();
  }

  /**
   * 启动（或复用）并加载面板。
   * 加载期间状态文本保持可见；webview/iframe 加载失败或 60 秒超时时显示错误视图 + 重启按钮，
   * 绝不静默空白（修复"端口上是半死服务/换过内核 → 面板纯白无提示"的事故）。
   */
  private async loadPanel(): Promise<void> {
    this.contentEl.empty();
    const status = this.contentEl.createDiv({ cls: "dsh-status" });
    status.setText("正在启动 DSH ...");

    const vaultPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();

    let url: string;
    try {
      const result = await this.plugin.manager.ensureRunning(vaultPath, (state) => {
        status.setText(state);
        this.plugin.updateStatusBar(state);
      });
      url = result.url;
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
        status.createDiv({ text: "安装后重新打开面板即可。" });
      }
      this.plugin.updateStatusBar("启动失败");
      new Notice(`DSH 启动失败：${message}`, 10000);
      return;
    }

    const showError = (hint: string) => {
      this.contentEl.empty();
      const err = this.contentEl.createDiv({ cls: "dsh-status" });
      err.setText(hint);
      const btn = err.createEl("button", { text: "重启 DSH 服务" });
      btn.onclick = () => void this.loadPanel();
    };

    status.setText("已连接，正在加载界面 ...");
    let settled = false;
    const timeoutTimer = window.setTimeout(() => {
      if (!settled) {
        showError("DSH 界面加载超时（60 秒），服务可能未就绪。请点击下方按钮重启服务。");
        this.plugin.updateStatusBar("加载超时");
      }
    }, 60_000);

    // 0.1.2+ 浏览器鉴权版：SameSite=Strict cookie 在跨站 iframe 里不发送（实测 401）。
    // 改用 Electron <webview>：独立渲染进程，guest 内的顶层导航下 cookie 正常发送。
    if (/\?token=/.test(url)) {
      const wv = this.contentEl.createEl(
        "webview" as unknown as keyof HTMLElementTagNameMap,
        { cls: "dsh-frame" }
      ) as unknown as HTMLElement;
      wv.setAttribute("src", url);
      wv.setAttribute("partition", `persist:dsh-${hashPath(vaultPath).toString(16)}`);
      wv.addEventListener("did-finish-load", () => {
        settled = true;
        window.clearTimeout(timeoutTimer);
        status.remove();
      });
      wv.addEventListener("did-fail-load", (e) => {
        settled = true;
        window.clearTimeout(timeoutTimer);
        // -3 = ABORTED（用户取消/窗口关闭），按正常处理不报错
        const code = (e as unknown as { errorCode?: number }).errorCode;
        if (code === -3) return;
        showError("DSH 界面加载失败（webview 错误）。请点击下方按钮重启服务。");
        this.plugin.updateStatusBar("加载失败");
      });
    } else {
      const frame = this.contentEl.createEl("iframe", { cls: "dsh-frame" });
      frame.setAttr("src", url);
      frame.addEventListener("load", () => {
        settled = true;
        window.clearTimeout(timeoutTimer);
        status.remove();
      });
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
    // 用 1.4.0 即有的 setActiveLeaf 聚焦（revealLeaf 需 Obsidian >= 1.7.2，会突破声明的 minAppVersion）
    workspace.setActiveLeaf(leaf);
  }

  updateStatusBar(text: string): void {
    if (this.statusBar) this.statusBar.setText(`DSH: ${text}`);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<typeof DEFAULT_SETTINGS> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
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
          .setPlaceholder(pickBestInstall(detectDshInstalls())?.cmd ?? "自动探测 / npx 在线安装")
          .setValue(this.plugin.settings.dshCommand)
          .onChange(async (value) => {
            this.plugin.settings.dshCommand = value.trim();
            await this.plugin.saveSettings();
          })
      );

    const best = pickBestInstall(detectDshInstalls());
    let channel: DshChannel = "stable";
    const channelLabel = (c: DshChannel) => (c === "stable" ? "稳定版" : "alpha 体验版");
    const updateSetting = new Setting(containerEl)
      .setName("dsh 版本更新")
      .setDesc(
        best?.version
          ? `当前使用本地 ${best.version}。选择通道后点「检查更新」才联网查询（稳定版 = npm 官方正式通道，alpha 体验版 = 官方预览通道），发现新版需确认后才安装。`
          : "未检测到本地 dsh，首次启动将 npx 在线安装。默认不自动升级，可手动检查更新。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("stable", "稳定版")
          .addOption("alpha", "alpha 体验版")
          .setValue("stable")
          .onChange((value) => {
            channel = value as DshChannel;
          })
      )
      .addButton((btn) =>
        btn.setButtonText("检查更新").onClick(async () => {
          btn.setDisabled(true);
          updateSetting.setDesc(`正在检查${channelLabel(channel)}通道最新版本 ...`);
          const result = await checkForUpdate(channel);
          if (result.kind === "error") {
            updateSetting.setDesc(
              channel === "alpha"
                ? "检查失败：无法访问 registry，或 alpha 通道暂无可用版本，保持当前版本。"
                : "检查失败：无法访问 registry（网络/代理问题），保持当前版本。"
            );
          } else if (result.kind === "up-to-date") {
            updateSetting.setDesc(
              result.version !== result.latest
                ? `${channelLabel(channel)}通道最新 ${result.latest}，本地 ${result.version} 更高，无需更新。`
                : `已是最新（${result.latest}）。`
            );
          } else {
            const { latest, current } = result;
            updateSetting.setDesc(
              `${channelLabel(channel)}通道发现新版 ${latest}${current ? `（当前 ${current}）` : ""}，等待确认。`
            );
            const notice = new Notice(
              channel === "alpha"
                ? `发现 alpha 体验版 ${latest}，是否安装？（升级会自动迁移会话数据，历史不丢）`
                : `发现稳定版新版本 ${latest}，是否安装？`,
              0
            );
            const frag = new DocumentFragment();
            const yes = frag.createEl("button", { text: "安装" });
            const no = frag.createEl("button", { text: "取消" });
            yes.onclick = async () => {
              notice.hide();
              updateSetting.setDesc(`正在安装 dsh ${latest} ...`);
              // 全局持续提示：不依赖设置页可见，用户关闭设置页也能看到安装进行中；
              // 周期刷新等待时长，避免误以为卡死。安装完成/失败后再给出结果提示。
              const installing = new Notice(`正在安装 dsh ${latest}（下载依赖，约需 1-2 分钟，请勿关闭 Obsidian）...`, 0);
              const startAt = Date.now();
              const ticker = window.setInterval(() => {
                const secs = Math.round((Date.now() - startAt) / 1000);
                installing.setMessage(
                  `正在安装 dsh ${latest}（已等待 ${secs}s，下载依赖中，请勿关闭 Obsidian）...`
                );
              }, 5_000);
              let ok = false;
              try {
                ok = await installLatestToManaged(latest);
              } finally {
                window.clearInterval(ticker);
                installing.hide();
              }
              if (ok) {
                new Notice(`dsh ${latest} 安装完成，下次打开面板自动启用。`, 10_000);
                updateSetting.setDesc(`dsh ${latest} 已就绪，下次打开面板自动启用。`);
              } else {
                new Notice(`dsh ${latest} 安装失败，保持当前版本，请稍后重试。`, 10_000);
                updateSetting.setDesc("安装失败，保持当前版本，请稍后重试。");
              }
            };
            no.onclick = () => {
              notice.hide();
              updateSetting.setDesc(`保持当前版本${current ? ` ${current}` : ""}，可随时重新检查更新。`);
            };
            notice.noticeEl.appendChild(frag);
          }
          btn.setDisabled(false);
        })
      );

    {
      const vaultPath = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
      const defaultBackupDir = join(vaultHome(vaultPath), "backups");
      new Setting(containerEl)
        .setName("数据备份目录")
        .setDesc(
          "升级到 0.1.2+（浏览器鉴权版）时会自动迁移会话数据，迁移前把旧数据备份到此目录。" +
            "留空则使用默认目录：" +
            defaultBackupDir
        )
        .addText((text) =>
          text
            .setPlaceholder(`留空 = ${defaultBackupDir}`)
            .setValue(this.plugin.settings.backupDir)
            .onChange(async (value) => {
              this.plugin.settings.backupDir = value;
              await this.plugin.saveSettings();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("folder")
            .setTooltip("在文件管理器中定位备份文件夹")
            .onClick(() => {
              const target = this.plugin.settings.backupDir.trim() || defaultBackupDir;
              try {
                mkdirSync(target, { recursive: true });
              } catch {
                // 创建失败仍尝试定位（文件管理器会打开最近存在的父级）
              }
              const electron = (window as unknown as {
                require?: (m: string) => { shell?: { showItemInFolder?: (p: string) => void } };
              }).require;
              electron?.("electron")?.shell?.showItemInFolder?.(target);
            })
        );
    }

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

  /** Obsidian 1.13+ settings search integration (optional but recommended). */
  getSettingDefinitions(): never[] {
    return [];
  }
}

//#endregion
