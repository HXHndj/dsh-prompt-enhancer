# DSH 0.2.0-rc.1 兼容性调查报告（dsh-prompt-enhancer 4.2.4 异常）

> 轮次定位：**调查报告轮**（只读调查，不改源码、不改产物、不部署）。
> 结论供下一轮「修复轮」直接执行。
> 调查时间：本机 DSH Desktop `0.2.0-rc.1`（`app.asar` mtime 2026-09-28 20:28），插件 `dsh-prompt-enhancer@4.2.4`。
> 调查方式：静态证据（装机包源码 + npm registry + 本机 profile 日志）为主，**未做实机部署**（遵守 `AGENTS.md` 用户指令）。

---

## 0. 结论摘要（TL;DR）

| 项 | 结论 |
|---|---|
| 硬阻断原因 | **只有一处**：`package.json` 的 `peerDependencies` 版本范围与 DSH 运行时版本判定不兼容（**由 DSH 0.2.0-rc.1 的启动门禁强制拒绝加载**） |
| 是否代码级断裂 | **否**。插件用到的客户端槽位、`ctx.slots`/`locale`/`dynamicCordisRunner` 服务、宿主端 11 个 cordis 服务、`webServer.register` 路由签名——在 0.2.0-rc.1 中**逐一核对仍存在**，本轮未发现必须改代码的证据 |
| 适配代价 | **极小**：`package.json` 两处（`peerDependencies` + `dsh.client.inject`）+ 文档/锁/CHANGELOG 同步 + 版本号提升；`src/**`、`lib/**` 预期零改动 |
| 一个被淘汰的依赖 | `@deepseek-ai/dsh-client-runtime` 在 0.2 线**已不存在**（最后发布于 `0.1.1-rc.2`），职责被拆分为 `dsh-client-ui-slots`（槽位纯核心）+ `dsh-client-store`（会话/工作区对象层）+ `dsh-client-ui-renderer`（`ctx.slots` 服务本体） |
| `dsh.client.inject` 的真实作用 | **仅"包名排序提示"**，官方定性为 *Informational package-name dependencies*；未命中的名字**静默跳过**，**没有任何阻断能力**（本仓库 `docs/compatibility-matrix.md:157` 的说法与之相反，属文档错误，待修） |
| `engines.dsh` 的作用 | **不被强制**——官方明示安装器/加载器都不校验 `engines.dsh` 与 `dsh.manifestVersion`；只作作者声明 |
| 门禁判定语义（关键） | 把**每个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 `peerDependencies` 范围**与「DSH 运行时版本」比对**（`semver.satisfies(..., { includePrerelease: true })`）——**与依赖名无关，也不查 npm/模块表** |
| 最快验证路径（零改动） | 用插件管理器/`dsh plugin allow-version` 授予 `dsh-prompt-enhancer@4.2.4 × 0.2.0-rc.1` **精确版本豁免**，先确认插件在 0.2.0-rc.1 上功能正常，再发适配版（豁免由用户执行） |

---

## 1. 现象与证据链

### 1.1 用户可见现象

插件管理页显示 `dsh-prompt-enhancer 异常`，红色原因文案：

> 原因: dsh-prompt-enhancer@4.2.4 与 DSH 0.2.0-rc.1 不兼容（要求 @deepseek-ai/dsh-client-locale ^0.1.0-rc.6, @deepseek-ai/dsh-client-runtime ^0.1.0-rc.6），运行它可能导致崩溃或数据丢失，请安装与当前 DSH 兼容的插件版本。

### 1.2 CLI 原始日志（同一条判定的英文原文，含处置方式）

`C:\Users\W\.dsh\profiles\desktop\.plugin-manager\logs\operation-u3GsUA\pnpm.log`（2026-09-28 21:30:51，升级后首次启动；`operation-UsGJLt` 同文）：

```
dsh: warning: Plugin dsh-prompt-enhancer@4.2.4 is incompatible with dsh 0.2.0-rc.1:
peerDependencies {"@deepseek-ai/dsh-client-locale":"^0.1.0-rc.6","@deepseek-ai/dsh-client-runtime":"^0.1.0-rc.6"}.
Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.
To accept this risk explicitly, grant the exact-version exemption for dsh-prompt-enhancer@4.2.4 on dsh 0.2.0-rc.1
with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh.
Exact-version exemption: not active.
dsh: it stays installed but profile startup denies it until you grant an exemption for those exact versions.
```

**关键事实：`profile startup denies it`** —— 不是"能加载但报错"，而是**整个插件（host 半部 + client 半部）在 profile 启动阶段被拒绝加载**。因此 ✨ 按钮与设置页入口全部不出现。

### 1.2b UI 文案的完整链路（截图 ↔ 代码闭合）

截图里的中文原因与 CLI 英文日志是**同一份结构化判定**的两个出口：

```
evaluatePluginCompatibility()                       // @deepseek-ai/dsh-app-boot
  → ManagementFailure("incompatible-version",
      [{ name, version, runtimeVersion, peers }])   // @deepseek-ai/dsh-plugin-manager
  → 前端模板 reasonIncompatibleVersion              // @deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:272
       "{plugin} 与 DSH {runtime} 不兼容（要求 {peers}），运行它可能导致崩溃或数据丢失。请安装与当前 DSH 兼容的插件版本。"
  → 填充处 client.js:583–587：peers = Object.entries(plugin.peers).map(([n,r]) => `${n} ${r}`).join(", ")
```

模板串与截图**逐字一致，连 peer 的排列顺序也一致**——这排除了"另有其它兼容性判定"的可能：异常就是本节这一条规则造成的。

### 1.3 时间线（本机实测时间戳）

| 时间 | 事件 |
|---|---|
| 2026-09-27 22:59 | 插件 v4.2.4 最后部署（`node_modules/dsh-prompt-enhancer` 版本 4.2.4，来源 `staged-install`，见 `.dsh\dsh-prompt-enhancer.deploy.json`） |
| 2026-09-28 20:28 | DSH Desktop 升级：`resources\app.asar` / `resources\runtime\primary-runtime\runtime.json` 写入，`desktopVersion = 0.2.0-rc.1` |
| 2026-09-28 21:30:30–21:30:52 | 新版本首次启动，重建 `profiles\desktop\cordis.yml` / `package.json`，执行 pnpm 操作并输出上述不兼容警告 |

> 注：`C:\Users\W\.dsh\dsh-runtimes\dsh-primary-runtime\runtime.json` 仍是 `0.1.7-rc.2`（9-24 写入），属**陈旧副本**；当前实际运行时来自 `app.asar`（`desktopVersion: 0.2.0-rc.1`）。

---

## 2. 根因分析

### 2.1 门禁实现（一字不差地核对过源码）

判定逻辑位于 0.2.0-rc.1 的 `@deepseek-ai/dsh-app-boot` 包内（`package/lib/index.js`，`lib/types/plugin-compatibility.js` 区块，第 286–322 行）。该代码由**两条独立取证路径**取得并逐字比对一致：① npm 发布的 `@deepseek-ai/dsh-app-boot@0.2.0-rc.1` tarball；② 直接从本机 `resources\app.asar` 解包读取。

```js
function getDshRuntimeVersion() {                      // 第 271–275 行
  const filename = fileURLToPath(new URL("../package.json", import.meta.url));
  const manifest = objectOf$1(JSON.parse(fs.readFileSync(filename, "utf8")), "app-boot package.json");
  return runtimeVersionOf(Object.hasOwn(manifest, "version") ? manifest.version : void 0);
}

function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
  runtimeVersionOf(runtimeVersion);
  const fields = objectOf$1(manifest, "Plugin manifest");
  if (!Object.hasOwn(fields, "peerDependencies")) return void 0;          // ← 无 peerDependencies ⇒ 直接放行
  const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
  const peers = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== "string") throw new Error(...);
    if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;   // ← 只审 dsh 系名字
    const requirement = ["workspace:^", "workspace:~", "workspace:*"].includes(range) ? runtimeVersion : range;
    if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }))
      peers[name] = range;                                                // ← 唯一的判定式
  }
  if (Object.keys(peers).length === 0) return void 0;
  ...
}
```

由此确定的四条语义（**决定了适配方案的全部自由度**）：

1. **比对对象是「DSH 运行时版本」**（`runtimeVersion` 默认取 app-boot 包自身 `package.json` 的 `version` = `0.2.0-rc.1`），**不是** npm 上某个包的版本，也**不是**客户端模块表里登记的版本。
2. **只有 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀的名字参与判定**；`@deepseek-ai/cordis`、`react` 之类一律跳过。
3. 判定用 `semver.satisfies(version, range, { includePrerelease: true })`——**预发布版本参与区间比较**；`workspace:^`/`~`/`*` 被视作当前运行时版本（等价放行）。
4. **完全没有 `peerDependencies` 字段 ⇒ `return void 0`（无任何不兼容）**。

官方文档对该规则的原文（`@deepseek-ai/dsh-app-boot@0.2.0-rc.1` `README.md:52`／`README.zh.md:52`）：

> Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` against **the single runtime version** returned by `getDshRuntimeVersion()`. Every declared range must match; prereleases participate in range matching. Source-workspace `workspace:^`, `workspace:~`, and `workspace:*` refer to that same runtime. **Missing DSH peers impose no constraint; invalid ranges are incompatible.** These checks use peer declarations, **not `engines.dsh`**, and are not a sandbox against malicious package code.

即：`runtimeVersion` 是**唯一一个值**（app-boot 包自身 `package.json` 的 `version`），**不存在"依赖名 → 版本"的对照表**；所有 dsh 系 peer 都拿同一个值去比对。

### 2.2 为什么 0.1.7-rc.2 能用、0.2.0-rc.1 不能用（数值实测）

用本机 `semver` 实测（`includePrerelease: true`，与门禁一致）：

| 运行时版本 | 声明范围 | 门禁判定 | 说明 |
|---|---|---|---|
| `0.1.7-rc.2` | `^0.1.0-rc.6` | **true** | 旧版通过（`^` 展开为 `>=0.1.0-rc.6 <0.2.0`，0.1.7-rc.2 落在区间内） |
| `0.2.0-rc.1` | `^0.1.0-rc.6` | **false** | 新版被拒（0.2.0-rc.1 **不** < 0.2.0） |
| `0.2.0-rc.1` | `>=0.1.5-rc.1` | **true** | 生态现行写法（见 §2.4） |
| `0.1.7-rc.2` | `>=0.1.5-rc.1` | **true** | 可同时兼容两条线 |
| `0.2.0-rc.1` | `^0.2.0-rc.1` | **true** | 仅兼容 0.2 线 |

**根因一句话**：插件声明的 `^0.1.0-rc.6` 上限是 `0.2.0`，而 DSH 主版本从 `0.1.x` 跨到 `0.2.0-rc.1`，于是**两条 peer 声明同时越界**，门禁把「全部 peerDependencies」原样打印出来（所以文案里两条都列了，即使它们失败原因相同）。

### 2.3 `@deepseek-ai/dsh-client-runtime` 在 0.2 线已被淘汰

| 证据 | 内容 |
|---|---|
| npm registry | `@deepseek-ai/dsh-client-runtime` 最后发布版本 = `0.1.1-rc.2`；**`@0.2.0-rc.1` 不存在**（`npm view ...@0.2.0-rc.1` 退出码 1）。对照：`dsh-client-locale`、`dsh-client-ui-slots`、`dsh-client-store`、`dsh-client-ui-renderer` **均有 `0.2.0-rc.1`** |
| 0.2.0-rc.1 实际配置 | `profiles\desktop\cordis.yml`（升级后 21:30:30 重建）列出 `dsh-client-modules`、`dsh-client-connection`、`dsh-cordis-client-runner`、`dsh-client-ui-renderer`、`dsh-client-locale` 等，**没有 `@deepseek-ai/dsh-client-runtime` 这一行** |
| 职责去向 | `dsh-client-runtime@0.1.0-rc.7` 自述「Client core services: **SlotRegistry**, SessionRuntime (scope tree + object layer)」；0.2 线拆为 `dsh-client-ui-slots`（SlotMap/SlotCore 纯注册表）、`dsh-client-store`（对象层/投影 store）、且 **`ctx.slots` 服务本体由 `dsh-client-ui-renderer` 提供**（见 §3.1） |

> 结论：`dsh-client-runtime` 这个名字在 0.2 上既不会出现在客户端启动图里，也不再被任何核心包提供。但**它本身不是阻断原因**——门禁不看名字（§2.1 第 1、2 条），看的是范围数值。它只是**语义过期的标注**，应一并更正。

### 2.4 同机「能用的插件」怎么声明（最有力的对照）

| 插件 | 是否被 0.2.0-rc.1 接受 | `peerDependencies` | `engines` | `dsh.client.inject` |
|---|---|---|---|---|
| `dsh-whale-widget@0.3.12` | ✅（已注册进 cordis.yml） | **完全没有该字段** | 无 | 无（无 client 半部） |
| `dsh-opencode-go@0.1.16-dev.1` | ✅ | 全部 `">=0.1.5-rc.1"`（含 `dsh-client-ui-slots`、`dsh-client-locale`、`dsh-client-ui-renderer`、`dsh-api-remotes` 等） | `dsh: ">=0.1.5-rc.1"` | `["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-ui-model-selection"]` |
| `dsh-prompt-enhancer@4.2.4` | ❌ | `^0.1.0-rc.6` ×2 | 无 | `["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-locale"]` |

**即：生态里被 0.2.0-rc.1 接受的写法是「下限式范围」（`>=0.1.5-rc.1`）或「不声明 peerDependencies」。**

### 2.5 `dsh.client.inject` 的真实语义（决定"要不要改"）

0.2.0-rc.1 的 `@deepseek-ai/dsh-client-modules`（`package/lib/client.js`）：

```js
// 第 656–659 行：按 inject 名单先让依赖行「到达」，再物化自己
for (const packageName of row.inject) {
  const dependency = this.graphRows.get(packageName);
  if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);   // ← 未命中则静默跳过
}
```

- `inject` 的语义 = **「这些包的 factory 必须先就位」**（启动图内的排序/可用性声明），不是版本约束。
- **未出现在启动图里的名字被静默跳过**：`dsh-client-runtime` 留在 inject 里**不会导致加载失败**，但也**不再起任何排序作用**。
- ①**它会加重误导**（看起来"插件依赖 dsh-client-runtime"，实际早已淘汰）；②插件 client 半部的 `apply()` 首行就是 `const slots = ctx.get('slots'); if (slots === undefined) return;`——**服务未就绪时静默不出 UI**。因此 inject 应指向 0.2 的真实提供者（见 §4）。

**官方对该字段的定性**（`@deepseek-ai/dsh-package-manifest@0.2.0-rc.1` 类型注释）：

> `inject?: string[]` — **Informational package-name dependencies, not Cordis service injection.**

注意它与 **Cordis 服务注入**是两套机制：`package.json` 的 `dsh.client.inject` 只是"包名排序提示"，而 `module.exports.inject = ['slots','locale','timer']`（在 `lib/client.cjs` 产物里）才是"等这些服务就绪再 apply"。官方插件开发技能（`@deepseek-ai/dsh-agent-preset` 内置 `cordis-plugin-development`）进一步明确：

> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; **`dsh.client.inject` entries only order activation** and stay allowed.

**⚠️ 本仓库文档存在一处事实错误（修复轮应一并更正）**：`docs/compatibility-matrix.md:157` 写「宿主缺失 → `dsh.client.inject` 不满足，**client 半部不注入**」——0.2.0-rc.1 的实现与该说法相反：`inject` **没有任何阻断能力**（未命中名字静默跳过，宿主侧排序只用 `external`），**真正会阻断整插件加载的是 `peerDependencies`**。该行需改写为"inject = 排序提示；阻断来自 peerDependencies"。

### 2.6 `engines.dsh` / `dsh.manifestVersion` 不被强制（修复轮的决策依据）

`@deepseek-ai/dsh-package-manifest@0.2.0-rc.1` `README.md:93` 原文：

> **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`.

因此 `dsh-opencode-go` 里的 `engines.dsh: ">=0.1.5-rc.1"` 只是**作者声明**，不参与 0.2.0-rc.1 的放行判定（门禁只读 `peerDependencies`）。同理，`dsh.manifestVersion` 也不参与。

生态实际写法（0.2.0-rc.1 随包数据）：官方模板 `cordis-plugin-development/templates/decoration/package.json` **整份没有 `peerDependencies`**：

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

统计口径：声明了 `dsh.client` 的 **73** 个随包插件中，**62 个完全不声明 DSH 系 peers**，另外 11 个精确 pin `"0.2.0-rc.1"`（或 `workspace:*`）。——即"不声明 peerDependencies"才是 0.2 线的**主流官方形态**；`dsh-opencode-go` 那种"全量下限范围"是**少数派但可用**的写法（本机实测已被接受）。

---

## 3. 兼容性核对表（逐项静态核对结果）

### 3.1 客户端（client 半部）

| 插件用法 | 0.2.0-rc.1 现状 | 证据 | 结论 |
|---|---|---|---|
| 槽位 `conversation.input.right` / `conversation.input.dock` | **存在** | `@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.1` 声明含二者 | ✅ 不变 |
| 槽位 `settings.section` | **存在** | `@deepseek-ai/dsh-client-ui-settings@0.2.0-rc.1` 声明含 `settings.section` | ✅ 不变 |
| 槽位 `sidebar.footer.action` | **存在** | `@deepseek-ai/dsh-client-ui-sidebar@0.2.0-rc.1` 声明含 `sidebar.footer.action` | ✅ 不变 |
| `ctx.get('slots')` → `slots.inject(name, cb)` / `slots.register(spec, Comp)` | 服务名 `slots` **仍然存在**，但**提供者变了** | `@deepseek-ai/dsh-client-ui-renderer@0.2.0-rc.1` `lib/client.js`：`class SlotRegistry extends Service` → `super(ctx, "slots")`（第 1280/1323 行），`ctx.slots.install(createSlotRenderer())`（第 1843 行） | ⚠️ **仅"谁提供"变了**；0.1.x 由 `dsh-client-runtime` 的 SlotRegistry 提供（该包 README 自述）。插件代码无需改，但 inject 应指向 renderer 行 |
| `ctx.get('locale')` → `locale.register(ns, lang, dict)` / `locale.bind(ns)` | **API 未变** | `@deepseek-ai/dsh-client-locale@0.2.0-rc.1` `lib/client.js`：`register(ns, localeOrDicts, dict)`、`bind(ns)`；类型 `register(ns, locale, dict): () => void`、`bind(ns): Translate` | ✅ 不变 |
| `ctx.get('dynamicCordisRunner')` | **存在** | `@deepseek-ai/dsh-cordis-client-runner@0.2.0-rc.1` `lib/types/index.d.ts` 第 93–96 行 `declare module '@deepseek-ai/cordis' { ... dynamicCordisRunner: CordisRunnerFace }` | ✅ 不变 |
| 槽位 props：`props.useSession` / `props.useInput` / `props.inputActions` | **仍注入** | `dsh-client-ui-renderer@0.2.0-rc.1` `lib/client.js` 第 705–720 行「every `hooks` source becomes a `use<Name>` selector hook — useSession is …；`props` spread verbatim」；`dsh-client-ui-conversation@0.2.0-rc.1` `lib/types/slots.d.ts` 第 336–346 行 `useInput: SnapshotSelectorHook<InputState>` / `inputActions: InputActions` | ✅ 不变（插件已有旧形态回退分支） |
| client 插件对象 `inject: ['slots','locale','timer']` | cordis 服务注入语义未变 | 与 §3.1 各行一致 | ✅ 不变 |

### 3.2 宿主（host 半部）

插件 host 半部通过 `ctx.get('<service>')` 使用的全部服务，在 0.2.0-rc.1 对应包中逐一核对存在：

`sessions`、`sessionQuery`、`sessionProjections`、`agents`、`agentDefaultModel`、`sandboxPolicy`、`fs`、`llm`、`web`、`webServer`、`dynamicCordisRunner` —— **全部命中**（`timer` 由 `@deepseek-ai/cordis-plugin-timer` 提供，profile 配置中该行在位）。

RPC 路由注册签名未变（`@deepseek-ai/dsh-host-webserver@0.2.0-rc.1` `lib/index.d.ts` 第 31–90 行）：

```ts
export type WebRouteKind = 'exact' | 'prefix';
export interface WebRoute { kind: WebRouteKind; path: string; handler: (req, res) => void | Promise<void>; }
register(route: WebRoute): () => void;
```

与 `lib/index.cjs` 的 `webServer.register({ kind:'exact', path: RPC_PATH, handler })` 完全一致 ⇒ **`/dsh-prompt-enhancer/rpc` 桥接仍可用**。

> **本节结论：本轮静态核对未发现必须修改插件代码的地方。** 阻断项只有 §2 的声明门禁；其余均为"标记过期"性质的维护项。实机功能验证见 §5。

---

## 4. 适配方案（下一轮「修复轮」执行）

### 4.1 推荐方案 A：最小改动 + 双线兼容（保 0.1.5+ 与 0.2.x）

`package.json` 仅两处（`docs/compatibility-matrix.md` §4.1 与之同步）：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-ui-renderer",   // 取代已淘汰的 dsh-client-runtime（0.2 的 ctx.slots 提供者）
      "@deepseek-ai/dsh-client-locale"
    ],
    "platform": "web"
  }
},
"peerDependencies": {                            // 门禁只比范围 vs DSH 运行时版本，与名字无关
  "@deepseek-ai/dsh-client-ui-renderer": ">=0.1.5-rc.1 <0.3.0-0",
  "@deepseek-ai/dsh-client-locale": ">=0.1.5-rc.1 <0.3.0-0"
},
"engines": { "dsh": ">=0.1.5-rc.1 <0.3.0-0" }    // 可选：纯作者声明，官方明示安装器/加载器都不强制（§2.6）
```

> **实施回填（2026-09-28，v4.2.5 已落地）**：与本节草案相比，**上限由 `<0.3.0` 收紧为 `<0.3.0-0`**——DSH 主要走 `-rc` 发布（0.2 线整体就是 rc），裸 `<0.3.0` 会把未来的 `0.3.0-rc.1` **静默放行**（semver 预发布参与比较：`0.3.0-rc.1 < 0.3.0` 成立），与「跨 minor 必须显式复核」的初衷相悖；`<0.3.0-0` 连 0.3.0 的预发布一并拦住，且不影响 npm 解析（严格 semver 下由已发布版本 `0.1.5-rc.3` 满足，实测解析通过）。落地内容另含：`test/manifest-compat.test.cjs` 六条契约、`engines.dsh`、README/兼容矩阵文档同步、`package-lock.json` 随声明重解析。

理由：
- `>=0.1.5-rc.1 <0.3.0-0` 在 `includePrerelease: true` 下**同时满足** `0.1.7-rc.2`（旧桌面线）与 `0.2.0-rc.1`（当前），并拒绝 `0.3.0` 及其预发布；比裸 `>=0.1.5-rc.1`（生态现状）更收敛。
- **保留 peer 声明（而非删空）的真实价值**：门禁是唯一会读它的机制，保留一个带上限的窗口 ⇒ 将来 DSH 升到 `0.3.x` 时插件会被**明确拒绝加载并给出原因**，而不是静默加载后在运行时炸掉——对自维护插件这是正向保护。
- inject 指向 `dsh-client-ui-renderer`（0.2 的 `slots` 服务行，其清单为 `dsh.client = { platform:'web', immediately:true }`，是真实启动图行）；`dsh-client-ui-slots` 是**纯库、无 `dsh.client` 行**，写进 inject 不产生排序效果。
- 未用到的 `dsh-client-store` **不需要**声明（插件不消费它）。
- **替代形态（官方主流）**：按官方模板**整块删除 `peerDependencies`**（§2.6，62/73 随包插件如此），插件在**任何** DSH 版本上都不再被门禁拒绝——维护成本最低，但失去"0.3 已被拒"的保护信号。二选一即可，**不要**采用"保留已淘汰包名 + 给个能过 0.2 的范围"这种半吊子写法（`@deepseek-ai/dsh-client-runtime` 在 npm 上根本没有 0.2.x，pnpm 侧 peer 解析会落空）。

### 4.2 备选方案

| 方案 | 声明 | 适用场景 | 代价 |
|---|---|---|---|
| B：仅 0.2 线 | `"^0.2.0-rc.1"` | 放弃 0.1.x 宿主，语义最干净 | 老 DSH 用户会被门禁拒绝 |
| C：不声明 peers | 删除 `peerDependencies` | **最快解阻断**，且是**官方模板/主流形态**（§2.6：官方模板无该字段，62/73 随包插件零 DSH peers） | 失去版本信号，任何版本都放行（`0.3` 破坏性变更也会静默加载） |
| D：零改动临时放行 | 插件管理器/`dsh plugin allow-version` 授予 `dsh-prompt-enhancer@4.2.4` on `0.2.0-rc.1` 精确豁免（写入 profile `compatibility.json`） | **下一轮第一步的三分钟验证**：先确认插件在 0.2.0-rc.1 上功能正常，再决定发版内容 | 需用户执行；属"接受风险"，仅作验证手段，不是修复 |

> 豁免机制来自同文件：`PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`，键为**精确** `name@version`，值为**精确** DSH 版本数组（`isExactPluginVersion` 校验收紧，range 一律拒绝）。

### 4.3 需要同步修改的文件（修复轮清单）

| 文件 | 改动 |
|---|---|
| `package.json` | §4.1 两处（+ 可选 `engines`） |
| `package-lock.json` | 根 `packages[""].peerDependencies` 同步（`npm install --package-lock-only`）；注意 lock 中现存 `node_modules/@deepseek-ai/dsh-client-locale` / `dsh-client-runtime` 条目（npm 7+ 会把根 peer 装进本地 `node_modules`），改声明后需重新解析；本地 `node_modules` 里那套 `0.1.0-rc.7` 包是按旧声明装出来的 |
| `docs/compatibility-matrix.md` | §4.1 客户端依赖边界表（两行 → 新名字/新范围）；§4 版本矩阵补一行（本次适配版本）；§4.1 说明段同步；**并修正第 157 行的错误机制描述**（"宿主缺失 → inject 不满足 → client 半部不注入" ⇒ 改为"inject 仅排序提示，不阻断；阻断来自 peerDependencies"，见 §2.5） |
| `README.md` / `README.en.md` 第 40 行 | 「官方渲染器（`@deepseek-ai/dsh-client-ui-renderer` ≥ 0.1.2-rc.1）」段补 0.2 线的 `slots` 提供者变更说明 |
| `CHANGELOG.md` | 新增版本段，按仓库纪律标注「**已实测**：<方式/等级>」（未实测不得合入） |
| 版本号 | **4.2.5**（用户拍板：按缺陷修复发 patch——本次只动清单声明，无对外行为变更、无 RPC/配置/schema 改动） |

`src/**`、`lib/**`、`plugin-host.js`、`cordis.patch.yml`：**预期零改动**，故 `build:host --check` / `build:client --check` 应保持"产物与源码一致"。

---

## 5. 下一轮验证计划（含"零改动先验证"路径）

**第 0 步（可选但强烈建议，用户执行）**：授予 4.2.4 × 0.2.0-rc.1 精确豁免 → 重启 → 确认 ✨/设置页在 0.2.0-rc.1 上**功能正常**（这一步把"声明问题"与"隐藏的运行时断裂"彻底分开）。

**第 1 步（代码面）**：
1. 改 `package.json`（§4.1）+ 同步 lock/文档/CHANGELOG；
2. `node scripts/build-host.mjs --check && node scripts/build-client.mjs --check`（期望"一致"）；
3. `npm test`（290+ 用例）与 `npm run gate`（预期零改动下全绿）；
4. 在**隔离实例**（临时 `DSH_HOME` + 随机端口，`web` profile 是指向本仓库的 junction）观察启动输出：**不得再出现** `is incompatible with dsh ...` 警告；
5. 校验门禁本身：可临时把 `peerDependencies` 设为方案 C（删除）做 A/B 对照，确认判定式与 §2.1 一致。

**第 2 步（真机面，用户执行）**：发布新版本 → 用户自行更新 desktop profile 并重启 → 插件列表显示"正常"、✨ 出现、设置页「模型与插件」三区 tab 正常、跑通一轮优化（记忆链/撤销/澄清卡按需抽验）。

> ⚠️ **运维要点**：当前 4.2.4 被启动门禁拒绝 ⇒ host 半部不运行 ⇒ 插件内置"一键更新"入口也不会出现。**因此不能用插件自带更新器自救**，必须走插件管理器/GitHub Release（或先授予豁免恢复入口）。

---

## 6. 风险与未决项（诚实清单）

| # | 项 | 状态 |
|---|---|---|
| R1 | 插件 client 半部在 0.2.0-rc.1 上的**实机渲染** | **未实测**（本轮遵守 AGENTS.md 未部署；第二路独立调查亦未运行应用）。§3 为静态核对。**通过门禁 ≠ 功能正常**——它只证明"不再被判为不兼容"。建议按 §5 第 0 步或隔离实例验证 |
| R2 | `apply()` 首行 `slots === undefined` 早退是**唯一静默失败点** | 0.2 中 `slots` 由 `dsh-client-ui-renderer` 提供（`immediately:true`）；若宿主物化顺序变化，插件会静默不注册 UI。修复轮建议把 inject 明确指向 renderer（§4.1 已含），并在实机确认一次 |
| R3 | `engines.dsh` 是否被门禁之外的路径消费 | **已验证：不被强制**（`dsh-package-manifest` README:93：「installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`」）。§4.1 中的 `engines` 纯属人类可读声明，加不加都不影响放行 |
| R4 | 插件自更新链路（`update/install`、执行器 3081、部署账本、`harness.pluginRuntimeDir`）在 0.2 的路径有效性 | **未验证**；与本次异常无因果关系，但属于"适配 0.2"的第二优先项 |
| R5 | 本机 `profiles\node_modules\@deepseek-ai\*` 仍是 `0.1.7-rc.2` 陈旧副本（新 DSH 从 `app.asar` 加载核心） | 已记录；排查此类问题时应以 `app.asar`/npm 为事实源，勿据陈旧目录误判"依赖缺失" |
| R6 | 输入框槽位 `conversation.input.right` 的**语义**（是否有新增 props/插槽行为变化） | 名称与 props 契约已核对（§3.1）；**增量行为差异**未逐行比对 0.1.7 vs 0.2.0 的槽位实现。附注：0.2.0-rc.1 同时存在 `conversation.composer.dock` / `conversation.composer.bar` 一族（官方技能示例用的就是 `conversation.composer.dock`），插件现用的 `conversation.input.dock` 仍完整存在，**无需迁移** |
| R7 | `@deepseek-ai/dsh-client-runtime` 的移除**没有官方说明** | 本机（asar + npm）**找不到任何移除/改名/弃用公告**；其职责去向（`ui-slots`/`ui-renderer`/`session`/`store`）是根据各包 description 与 exports 的**推断**，非官方表述。修复轮不依赖该推断（只依赖"0.2 无此包"这一事实） |
| R8 | profile `compatibility.json` 解析器内部细节、以及本机是否已有历史豁免 | **未展开**（仅确认文件名常量、精确 `name@version` × 精确 DSH 版本的数据形状，以及"豁免不跨插件/DSH 升级继承"）。§5 第 0 步若走豁免路径，由插件管理器写入该文件即可，无需手改 |

---

## 7. 附录

### 7.1 本轮只读调查产生的证据位置

- 门禁源码（本轮提取，两路取证）：`D:\Desktop\网页设计\dsh-recon-lead\cli\deepseek-ai-dsh-app-boot-0.2.0-rc.1\package\lib\index.js`（第 250–322 行）；第二路从 `app.asar` 直接解包的同名文件 + 可执行的复现脚本：`D:\Desktop\网页设计\dsh-recon-020\REPORT.md`（809 行）及同目录 `extracted\`、`repro\`、`client-manifests.txt`、`host-packages-0.2.0-rc.1.txt`
- 官方规则原文：`@deepseek-ai/dsh-app-boot@0.2.0-rc.1` `README.md`/`README.zh.md` 第 52 行；`@deepseek-ai/dsh-package-manifest@0.2.0-rc.1` `README.md` 第 93 行
- 官方插件开发技能（事实上的编写/迁移指南）：`@deepseek-ai/dsh-agent-preset@0.2.0-rc.1` → `package/skills/cordis-plugin-development/`（`SKILL.md`、`references/practices.md`、`references/ui-plugin.md`、`templates/decoration/package.json`）
- UI 文案链路：`@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.1` `lib/client.js:272`（模板）/`:583-587`（填充）
- 客户端语义证据：`D:\Desktop\网页设计\dsh-recon-lead\` 下的 `dsh-client-modules`、`x-dsh-client-ui-renderer`、`dsh-client-ui-slots`、`dsh-client-ui-conversation`、`dsh-client-ui-settings`、`dsh-client-ui-sidebar`、`dsh-client-locale`、`x-dsh-cordis-client-runner`
- 宿主服务名证据：`D:\Desktop\网页设计\dsh-recon-lead\hostsvc\`（12 个 0.2.0-rc.1 宿主包）
- 本机日志：`C:\Users\W\.dsh\profiles\desktop\.plugin-manager\logs\operation-{u3GsUA,UsGJLt}\pnpm.log`
- 0.2.0-rc.1 实际配置：`C:\Users\W\.dsh\profiles\desktop\cordis.yml`（升级后重建）

> **清理说明（2026-09-28，按用户要求）**：上面列出的**仓外**证据/临时目录（`dsh-recon-lead\`、`dsh-recon-020\`、`dsh-peerresolve-test\`、`dsh-peerresolve-ctl\`）与 `acl-diagnostics\` 已在 v4.2.5 发布后删除，以保持本机目录清洁；本文档保留其路径与结论作为过程记录，这些路径此后不再可解析（仓库外无残留）。

### 7.2 环境附注（与插件无关，但影响本轮排障）

本轮开始时**所有 shell 命令被沙箱拒绝**，报错 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`。按 `diagnose-windows-sandbox-acl` 技能诊断：工作区目录缺 `WRITE_OWNER`（verdict = `PRECONDITION`），已按技能规定的最小修复 `-GrantFullControl` 补一条**当前用户**完全控制 ACE 并验证通过（随后 shell 恢复正常）。

- 证据与备份：诊断/修复报告与 DACL 备份（含生成的回滚脚本）曾落在 `D:\Desktop\网页设计\acl-diagnostics\`；**2026-09-28 按用户要求随临时目录一并删除**——保留回滚脚本等于在本机常驻一份随时可执行的特权脚本，与「保持目录清洁」的要求冲突。**该修复本身未回退**：工作区目录上仅多一条**当前用户**完全控制 ACE，未改动 owner、继承与 SACL，也未影响其他账户权限。

### 7.3 本轮改动声明

**本轮未修改仓库任何文件**（`src/**`、`lib/**`、`package.json`、产物均未动，`git status` 干净）；新增内容仅为本报告文件与仓库外的调查/诊断目录。所有"应该怎么改"的内容均为**下一轮的提案**，尚未落地。
