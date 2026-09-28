# dsh-prompt-enhancer 兼容性矩阵

> 维护：架构重构 M0 基线
> 用途：明确 RPC / 配置 / 形态 / 版本兼容边界，作为重构期间防回归依据。

---

## 1. 支持形态

| 形态 | 持久性 | 更新方式 | 是否支持一键更新 |
|---|---|---|---|
| bundle | ✅ 持久 | `dsh plugin add/update` + 重启 | ✅ |
| 动态 Cordis | ❌ 会话级 | `cordis_define` + `cordis_run` | ❌ |
| 脚本副本 | ✅ 持久 | 覆盖文件 | ❌ |

---

## 2. RPC 方法清单

### host RPC（`/dsh-prompt-enhancer/rpc`）

| 方法 | 方向 | 说明 | 权限 |
|---|---|---|---|
| `enhance` | client → host | 执行增强 | 用户触发 |
| `enhance/progress` | client → host | 增强进度 | 只读 |
| `cancel` | client → host | 取消增强 | 用户触发 |
| `models/list` | client → host | 模型列表 | 只读 |
| `models/current` | client → host | 当前模型 | 只读 |
| `models/resolve` | client → host | 解析模型 | 只读 |
| `models/test` | client → host | 连通性测试 | 用户触发 |
| `models/stats` | client → host | 模型实测统计（扫会话投影聚合 TTFT / tokens-per-second，附预估秒数：`estimateBase`=直发估算、`estimateLite`=保守上界，字段名沿用 v3） | 只读 |
| `models/autochain` | client → host | 自适应链 | 只读 |
| `template/default` | client → host | 默认模板 | 只读 |
| `update/check` | client → host | 版本检测（local 运行时读运行环境 package.json） | 只读 |
| `update/pull` | client → host | 拉取清单文件 | 用户触发 |
| `update/envcheck` | client → host | 环境检测 | 只读 |
| `logs/last` | client → host | 诊断日志 | 只读 |
| `plugins/inventory` | client → host | 插件清单 | 只读 |
| `plugins/run` | client → host | 运行插件 | 管理 |
| `plugins/stop` | client → host | 停止插件 | 管理 |
| `plugins/undefine` | client → host | 取消定义 | 管理 |
| `update/executorEnsure` | client → host | 拉起/对齐执行器（版本+内容哈希） | 用户触发 |
| `update/install` | client → host | 安装已下载的 staged 包（sha256 校验 → 解包覆盖运行环境 → 写部署账本，返回 `{ok, installed, version, restartNeeded:true}`；**不重启**，装完提示手动重启 DSH） | 用户触发 |
| `update/restartNeeded` | client → host | 检测未重启 | 只读 |
| `update/diagTail` | client → host | 诊断日志尾部补取（只读·脱敏；更新/重启失败路径补 DSH err 日志根因） | 只读 |
| `config/get` | client → host | 读取磁盘配置（$DSH_HOME/dsh-prompt-enhancer.config.json；DSH Desktop 动态端口配置恢复） | 只读 |
| `config/set` | client → host | 写入磁盘配置（原子写 tmp+rename，≤1MB） | 用户触发 |

> 注：`models/*` / `plugins/*` / `logs/*` / `template/*` / `update/check`·`update/pull`·`update/envcheck` / `enhance*` / `cancel` 共 18 条注册于 `plugin-host.js`（经 `lib/index.cjs` 桥接）；`config/*` / `update/executorEnsure`·`update/install`·`update/restartNeeded`·`update/diagTail` 共 6 条直接注册于 `lib/index.cjs`。两侧同挂 `/dsh-prompt-enhancer/rpc`，合计 **24** 条（插件内重启能力退役后重算：`update/portRestart` / `update/makeShortcut` 两条 RPC 已移除，`update/install` 与 `update/diagTail` 为现行集合；以两文件 `harness.handle(` 枚举逐条对照）。

> 注：`update/executorEnsure` / `update/install` / `update/restartNeeded` 在 host RPC 清单中保留（部分版本由 client 直连执行器 3081），见 executor RPC；执行器自插件内重启能力退役后只负责**下载 / 校验 / 安装 / 回滚**，不再重启。

> 注（**P2 · 2026-09-19 · 参数校验申报**）：上述 24 条中 **9 条有参数校验**（`lib/rpc-schema.cjs` 的 `schemas`），另 **15 条无校验且在此具名申报**——**禁止按类别笼统豁免**；新增线上方法却不申报、或申报过期，都会被 `node scripts/rpc-manifest.mjs --check` 拒绝（事实源由注册面派生，不靠人工清点）。
>
> | 方法 | 桶 | 理由 |
> |---|---|---|
> | `cancel` | **A** 无参/只读 | 只读：取消信号（无匹配时静默成功） |
> | `enhance/progress` | **A** 无参/只读 | 只读：查询优化进度（不存在的 seq 返回空） |
> | `logs/last` | **A** 无参/只读 | 无参只读：返回日志环 |
> | `models/autochain` | **A** 无参/只读 | 入参仅 noCache 布尔，宽松语义即契约 |
> | `models/current` | **A** 无参/只读 | 无参只读：读当前选择的模型 |
> | `models/list` | **A** 无参/只读 | 无参只读：列举 provider 与模型 |
> | `models/stats` | **A** 无参/只读 | 入参仅 provider/model/inputChars 展示用，非法值退化为空统计（无副作用） |
> | `plugins/inventory` | **A** 无参/只读 | 只读：列举插件清单 |
> | `template/default` | **A** 无参/只读 | 无参只读：返回内置模板目录 |
> | `update/restartNeeded` | **A** 无参/只读 | 只读：文件 mtime 比对，无副作用 |
> | `models/resolve` | **B** 有参·保持宽松 | 有参（provider/model）保持宽松：非法值由下游 resolveModelInfo 兜底，收紧急属 BREAKING |
> | `plugins/stop` | **B** 有参·保持宽松 | 有参（pluginId）保持宽松：非法 id 由插件面自行返回 not-found |
> | `plugins/undefine` | **B** 有参·保持宽松 | 有参（pluginId）保持宽松：同上 |
> | `update/executorEnsure` | **B** 有参·保持宽松 | 有参（port）保持宽松：非法端口由执行器侧拒绝 |
> | `update/pull` | **B** 有参·保持宽松 | 有参（repo/sessionId）保持宽松：本仓无调用点（handler 按决策保留），收紧收益为零 |
>
> **A 桶** = 无参 / 只读 / 无副作用入参，无可校验之物。**B 桶 = 有入参但保持宽松**——补校验会把既有「静默容忍」的调用变成 **400**，属**已发布对外行为变更**，须单列并标 BREAKING 由用户拍板，故本轮**只申报不收紧**（圆桌决策 A 的边界）。
### executor RPC（`127.0.0.1:3081/rpc`）

| 方法 | 说明 |
|---|---|
| `ping` | 心跳 / 版本 |
| `status` | 当前状态 |
| `apply` | 安装（下载 → sha256 校验 → 落 staging → 安装 → 失败回滚；**不含重启**） |

---

## 3. 配置项清单

### host / 全局配置

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | string | `standard` | 优化模式（v4.0.0 三档：`lite`/`standard`/`expert`；旧值迁移：base→standard、lite→lite、smart/publish→expert、`memory`→lite） |
| `memory` | boolean | `true` | 记忆流开关（v4.0.0 起默认开启；三值语义——历史显式 `false` 保持关闭）；链长 ≤3 轮（每轮 = 草稿 + 优化结果）；清链触发 = 发送消息 / 手动清空输入框 / 切换优化模式，刷新保留（按会话持久化）；**v4.4：专家档固定视为开启（存储值不覆盖，开关仅对轻量/标准生效）** |
| `context.budgetChars` | number | `8000` | 记忆链总预算（v4.1 起全局单选 8000/16000/32000；旧值 0/2000/4000/非法→8000，8000/16000/32000 原样保留——32000 不再降级；不再按模式分档） |
| `timeoutMs` | number | 见代码 | 超时（按档位默认 30s/30s/60s = 轻量/标准/专家） |
| `maxTokens` | number | 见代码 | token 上限（按档位 2000/2000/4000；推理链自动放宽 ≥8000 不变） |
| `outputLimit` | number | 见代码 | 输出上限（按档位 8000/8000/16000，超限判失败走下一条模型） |
| `template.mode` | string | `builtin` | 模板模式（兼容保留；新 UI 以每模式 `pick` 为准） |
| `template.texts` | object | 内置 | 每模式模板（兼容保留；有 `pick` 时不再参与解析） |
| `template.pick` | object | 各模式 `default` | 每模式选中模板键（v4.0.0 单模板体系）：`default`（每档唯一内置模板）/ `custom:<index>`（自定义列表条目）；旧键 increment/supplement/dev 迁移为 `default`，非法/越界回退 `default` |
| `template.custom` | object | 各模式 `[]` | 每模式自定义模板列表 `[{name, text}]`：≤10 条/模式，`text` ≤4000，`name` ≤40 |
| `fallback` | array | 内置 | 模型链（v3.6 起 UI 单选：恒写长度 1 数组；host 契约不变，旧多模型配置提示式收敛） |
| `customModels` | array | `[]` | 自定义模型 |
| `order` | array | 内置 | 模型顺序 |

### updater 配置

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `updater.serviceName` | string | `dsh-web` | 服务名 |
| `updater.profile` | string | `web` | profile |
| `updater.executorPort` | number | `3081` | 执行器端口 |

### client localStorage

| key | 说明 |
|---|---|
| `dsh-prompt-enhancer:config` | 配置缓存（重构后迁移至 entry config） |
| 会话内存 `memoryRounds` | 记忆链（RPC 载荷，仅内存，≤3 轮） |
| `dsh-enh-memory:<sessionId>` | 记忆链持久化（刷新保留；清链时 `removeItem`；与 `dsh-enh-result:<sessionId>` 独立） |
| `dsh-enh-clarify:<sessionId>` | 澄清问答持久化（v4.4：已答/keep 记录随链存活，后续每次优化携带；刷新保留；清链三触发同步 `removeItem`；撤销优化不回退；≤9 条） |
| `dsh-enh-opt:<sessionId>` | 「已优化」标记（v4.2.3/F5：值恒 `1`、缺键即 false；完成应用置位、undo 随链、清链删键；刷新/回收重建后恢复——「重新优化」入口不退化为「首次」） |

---

## 4. 版本兼容矩阵

| 插件版本 | client protocol | executor protocol | 说明 |
|---|---|---|---|
| ≤ 2.8.3 | 隐式 | 0.1.5 / 0.1.6 | 无显式协议版本 |
| 3.0.0（重构目标） | `protocolVersion: 1` | `protocolVersion: 1` | 显式协商 |
| 3.2.x | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | update/portRestart 独立化（服务模式 schtasks / 默认模式脚本）；执行器专注一键更新/watchdog（该 RPC 与 watchdog 已于 3.3.x 之后的迭代退役，此处仅作历史版本对照） |
| 3.3.x – 3.4.0 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | v3.3.3 起执行器副本同步 `undici` 依赖（缺失时代理能力降级为直连，进程不崩）；`update/serviceInstall` 已移除（不再提供 nssm 服务化安装入口）；**插件内重启能力退役**——`update/portRestart` / `update/makeShortcut`、执行器 `restart` 方法、watchdog 与维护救援 CLI 全部移除；新增 `update/install`（安装已下载的 staged 包），**装完提示手动重启 DSH 生效** |
| 3.5.0 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **BREAKING：语音识别（🎤）整体移除**（DSH 官方桌面端已内置，插件内重复实现剥离）——`voice/*` 共 10 条 RPC 连同 schema 下线，线上注册面 34 → **24** 条（即 §2 现行清单）；语音模型下载代理（`download.proxy` 配置）与设置页「语音识别」段落一并移除；安装/更新事实源迁移至 fork 仓库 `HXHndj/dsh-prompt-enhancer`；✨ 提示词增强不受影响 |
| 3.5.1 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **模型配置单选化**（客户端行为变更，host RPC 面与配置 schema 零改动）：设置页「模型配置」由多模型队列改为单选卡片（逐行分层布局，「上移/下移」退役），界面恒写长度 1 的 `fallback` 数组；模型来源 = `models/list` 的 DSH 已配置模型 + 内置候选；失败原因分类提示（连接/超时/模型不存在/凭证额度等，行内测试与增强错误条两路）；旧多模型配置仅显示收敛提示、不做加载时自动改写 |
| 3.5.2 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **设置界面层级化重构**（纯客户端 UI/样式，RPC 与配置 schema 零改动）：「优化参数」tab 重构为四级层级布局（分组/字段行/字段说明/页脚，短横线与细横线层级元素，控件位置预算）；设置导航去 emoji 纯文本；模型配置区去折叠、内容常显；`collapsible-section.js` chunk 退役（装配清单同步） |
| 3.5.3 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **输入框分裂按钮 + ▾ 增强模型菜单**（仅 client 半部，host 零改动、零新 RPC）：`conversation.input.right` 改 `[✨ 主键][▾]` 组合体——主键状态机保留，**空输入主键由「点击=切记忆」改为禁用置灰**（用户可见行为变更），记忆开关迁入 ▾ 菜单；菜单含记忆开关 + 增强模型按提供方分组列表（与设置页同一 `fallback[0]` 通道、双向同步）+ 思考等级（`models/resolve` 能力表）；新增 `enhance-menu.js` chunk（装配链同步）；形态对齐 DSH `ui-model-selection` |
| 3.5.4 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **▾ 菜单两级下钻**（纯呈现层级重构，数据与写入通道零变化）：一级恒三行（记忆开关就地切换 / 模型选择 / 努力程度，行内显示当前值）；模型与努力程度下钻二级面板（返回头 + 分组列表/efforts + ✓）；下钻落当前行、返回落原格、Escape 逐级退出；仍写 `fallback[0]` 与设置页双向同步 |
| 3.5.5 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **三处对齐修复 + 记忆链开关控件**（纯客户端呈现层，host RPC 面与配置 schema 零改动）：▾ 触发器字形归位 hover 高亮胶囊中心（`padding:0 4px` + `justify-content:center`，胶囊总宽不变）；「撤销优化 / 继续优化」纯文字态补 `.dsh-enh-btn-center`（左右 6/6，胶囊总宽不变）；▾ 菜单一级记忆行值位改开关控件（形态/色板对齐宿主原生 Switch：36×20 轨道 + 16px 滑块 + `translateX(16px)`，关 = `border-l3` / 开 = `brand-primary` / 滑块 = `label-primary-foreground`），行 `role=menuitemcheckbox` + `aria-checked` 承载状态 |
| 3.5.6 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **▾ 菜单新增「模式切换」一级行 + 二级模式面板**（纯客户端呈现层扩展，host RPC 面与配置 schema 零改动）：一级第 4 行（行内当前模式短标签 + `›`）→ 二级面板列 `MODE_OPTIONS` 全量 5 模式（全称 + `✓` 当前；选中自定义模板的模式带模板名标签）；选择写 `config.mode` + 该模式默认档位（与设置页 ParamsTab 同语义），经 `subscribeConfig` 联动输入框主键短标签与设置页；返回归位改按 key 查（`rootKeysRef` 行序镜像，努力程度行隐藏时不错位） |
| 4.2.5（当前） | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **DSH 0.2.0-rc.1 兼容性适配（清单声明层，`src/**`/`lib/**` 零改动）**：0.2.0-rc.1 的 profile 启动门禁把 `peerDependencies` 中每个 `@deepseek-ai/dsh[-*]` 范围与**运行时版本**比对（`semver.satisfies(runtime, range, {includePrerelease:true})`），任一条不满足即**拒绝加载整个插件**——v4.2.4 的 `^0.1.0-rc.6`（等价 `>=0.1.0-rc.6 <0.2.0`）在宿主升到 0.2.0-rc.1 当天即被判「异常」。修法：① 两条 dsh 系 peer 改**双侧窗口** `>=0.1.5-rc.1 <0.3.0-0`（0.1.7-rc.2 与 0.2.0-rc.1 均满足；上限 `-0` 连 0.3.0 的预发布一并拦住——DSH 主要走 rc 发布，写 `<0.3.0` 会让 `0.3.0-rc.1` 静默放行）；② `dsh.client.inject` 中已淘汰的 `@deepseek-ai/dsh-client-runtime`（0.2 线无此包）换成 0.2 的 `ctx.slots` 提供者 `@deepseek-ai/dsh-client-ui-renderer`；③ 新增可选 `engines.dsh` 同窗口（官方明示安装器/加载器**不强制**）；④ 新增 `test/manifest-compat.test.cjs` 六条契约（禁 `^`/`~`、双侧窗口、淘汰名双向禁入、inject 形制、engines 同源、版本单一事实源）。RPC 面 24 条、配置 schema、槽位名与全部客户端组件**零改动** |
| 4.2.4 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **忙碌态三连修 + 耗时胶囊**（**纯客户端呈现层，host 零改动、零新 RPC、配置 schema 与记忆链结构零改动、无行为变更**）：① **圆环光学居中**——实测根因是 13px/600 中文墨迹中心比行盒中心低 1.5px（DengXian 栈 natural ascent 14 / descent 3、行盒 20px），圆环本身已由 flex 居中在胶囊中心，故把忙碌态状态文字上移 1.5px（`.dsh-enh-btn-busy .dsh-enh-status{position:relative;top:-1.5px}`，纯绘制位移、取消覆盖层同步），环−墨迹偏差 −1.5px → 0.0px；② **悬停底色红化**——新增 `.dsh-enh-btn-busy:hover:not(:disabled){background:color-mix(state-error-primary 10%)}`（原被通用 `.dsh-enh-btn:hover:not(:disabled)` 覆盖成中性灰；同权重 0-3-0 靠源码顺序取胜，单测锁序）；③ **新增忙碌态耗时胶囊 `[00:08]`**（预设①：主键左侧独立淡底小胶囊）——`.dsh-enh-timer` 28px 高 / 全圆角 + `corner-shape:round` / `label-secondary` 6% 淡底 / `tabular-nums` 等宽数字 / `margin-right:2px`；`mm:ss` 格式、本地秒表 1s 一跳（`timerSvc.interval`，进入 enhancing 起算，**不复用** `enhance/progress` 的 `elapsedMs`——500ms 轮询值轮询失败会冻结）；纯展示：`aria-hidden` + `pointer-events:none` + `user-select:none` + 无 tabIndex，作为主键**兄弟节点**渲染（`.dsh-enh-split` 顺序扩为 `[aux, timer, main, EnhanceMenu]`，null 槽忽略；副键只在 result/idle、timer 只在 enhancing ⇒ 非忙碌态结构契约不变） |
| 4.2.3 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **多会话状态隔离修复**（客户端状态机 + host 入参校验；RPC 注册面/schema 零改动）：**切换优化模式只清空切换动作所在会话的记忆链**（▾ 菜单清菜单所在对话、设置页清当前聚焦对话；原全局清链+残键清扫删除——跨会话误伤与启动期磁盘同步误清零）；结果消费收敛为 helpers.`consumeResult` 单实现（EnhanceButton/EnhanceBar 两份 effect 同源，任意执行顺序一致）且**瞬态帧挂起**（切回/刷新首帧草稿未回灌 ⇒ 不消费不删键，回灌 backup 后自动回注）；清链（链世代 chainEpoch）后在途结果**应用但不入链**；`enhance()` 完成回调 away 判定改**实例本地 liveness**（第 7 参，原全局 activeSessionId 拆分为仅供设置页切档的 focusedSessionId）；「已优化」标记持久化 `dsh-enh-opt:` 新键；死键 `dsh.enhance.seen.` 删除；切会话收起 ▾ 菜单；**host enhance/cancel/progress 缺失 sessionId 由静默兜底（unknown/空串）改为报 BAD_ARGS（对外行为变更，CHANGELOG 单列）** |
| 4.2.2 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **副键布局重排 + 「继续优化」蓝色态 + 「重新优化」同形中性底**（**纯客户端呈现层，host 零改动、零新 RPC、配置 schema 与记忆链结构零改动、无行为变更**）：`.dsh-enh-aux` 由「`min-width:20px` + `padding:0 4px` + `margin-right:-2px`」（盒宽随内容：⟳ 字形 20px / ↩ SVG 22px，两态选中范围差 2px 且与主键盒重叠 2px）改为**固定 28×28 圆**（`width/min-width/height:28px` + `padding:0` + `inline-flex` 居中 + `margin-right:2px` + `border-radius:999px`），图标容器固定 `16×16` 盒（字形与 SVG 共用光学盒）；新增 `corner-shape:round` **显式退出宿主全局 `corner-shape:superellipse(1.5)`**（宿主 `*{corner-shape:var(--dsw-corner-shape)}` 会把大圆角压成小圆角方块——实机实测声明 24px 只渲染 ≈8px；宿主自家 Pill/Switch 同款退出做法）；新增 `.dsh-enh-btn-continue`（蓝字 + 6% 淡蓝底，与 `.dsh-enh-btn-result` 同配方，蓝 = `--dsw-alias-state-business-primary`，**不用中性的 `brand-primary`**）与 `.dsh-enh-btn-redo`（`label-secondary` 文字 + 6% 中性底；**不用 `bg-layer-2/3`**——深色主题下正是工具行面板底色会隐形） |
| 4.2.0 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **双键按钮状态机 + 从零重新优化 + 撤销放开 + 小三角箭头方向动画**（**纯客户端，host 零改动、零新 RPC、配置 schema 零改动**）：主键四态（首次 ✨+模式标签 / **撤销优化** / 已改+记忆开=**继续优化** / 已改+记忆关=**重新优化**），左侧新增副键 `.dsh-enh-aux`（**⟳ 从零重新优化** = 请求不带 `memory`/`answers`（新开对话式从零，**结果照常入链**）/ **↺ 撤销优化**）；`enhance()` 增第 6 参 `fresh` + store 新字段 `freshRun`/`freshAnswers`（**不持久化**，终稿时并入 `clarifyAnswers`）；`undo()` 放开到 idle 态（可连环回退，回退点 = 该轮 `input`，链空即回「首次」态）；▾ 触发器与设置页 chip select 的小三角箭头在展开态旋转 180°（`aria-expanded` 为唯一状态源，`transition:transform .18s ease`，尊重 `prefers-reduced-motion`） |
| 4.1.0 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **记忆流语义修订 + 澄清卡 kind 协议 + 澄清记录入链 + 按钮三态 + 专家档固定记忆**：记忆流清链三触发（发送/手动清空/切模式，含 localStorage 残键清扫）+ 刷新保链（`dsh-enh-memory:` 键）+ 预算改 8000/16000/32000（32000 不再降级）+ 轮数 ≤3 + 草稿永不截断/整轮装填/行边界截断+ 澄清问答独立通道（不占轮次）；澄清答案 `via` 扩为 option/custom/**keep**（v4.3：keep = 保留原句、a 空串；跳过 = `skip:true` + 全题 keep 条目）；澄清记录持久化 `dsh-enh-clarify:` 键、随每次请求携带（v4.4）；`parseClarify` 容错加固（围栏/尾注/重试/CLARIFY_MALFORMED，裸 JSON 不当终稿）；专家档 `mode:'expert'` 记忆恒视为开（v4.4，开关仅 lite/standard 生效）；按钮三态「重新优化/继续优化」与 host diff 同源（v4.4）；`req.continue` 死字段删除。全部向后兼容（配置自动迁移，旧 client 不受影响） |
| 4.0.0 | `protocolVersion: 1` | 0.1.12+（内容哈希重建） | **BREAKING：三档重构**——五模式收敛为 轻量/标准/专家（默认 standard，T1/T2 双模板由档位吸收，`template.pick` 旧键 increment/supplement/dev→default）；**全部会话/工作区/网络检索下线**（`retrieve` stage 移除，管道 4→3：analyze→assemble→llm；旧 base/smart/publish 模式删除，配置自动迁移 base→standard、smart/publish→expert）；专家档新增**歧义澄清卡**：enhance 请求可选 `answers`（`[{q,a,via}]`，via=option|custom，自由输入与草稿同效力且优先于同题选项）/`skip` 透传、响应新增 `clarify` 分支（questions[].kind=ambiguity|gap，仅透传不渲染；向后兼容，旧 client 不受影响）；草稿以 JSON 证据正文注入（防注入）＋保护 token 纪律；记忆流默认开启（三值语义；链长 ≤3 轮——发送消息 / 手动清空输入框 / 切换优化模式即清链，刷新保留，澄清问答独立通道不占轮次）；上下文预算收敛为全局记忆链预算（现行档位 8000/16000/32000，默认 8000；旧值 0/2000/4000/非法→8000，32000 不再降级）；运行参数按档位（30/30/60s、2000/2000/4000、8000/8000/16000） |

兼容策略：

- host 与 client 通过 `protocolVersion` 协商，不匹配时返回明确错误。
- executor 版本由 `EXECUTOR_VERSION` + **内容哈希**（.executor-hash）管理，`executorEnsure` 负责对齐（代码变自动重建，不依赖手动 bump）。
- 旧 client + 新 host：优先兼容层；无法兼容时提示刷新/升级。
- 版本检测：本地版本**运行时读运行环境 package.json**（非构建硬编码），发版后产物与版本号天然一致。

### 4.1 客户端依赖边界

| 依赖 | 声明处 | 版本边界 | 不满足时行为 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-renderer` | `package.json` `peerDependencies`（与 `dsh.client.inject` 同名列） | `>=0.1.5-rc.1 <0.3.0-0` | **阻断项**：DSH 0.2.0-rc.1 起 profile 启动门禁逐条比对 dsh 系 peer 与运行时版本，**任一条不满足 ⇒ 整包被拒**（host/client 都不加载，插件列表显示「异常」）。该包自 0.2.0-rc.1 起是 `ctx.slots` 服务的提供者（`SlotRegistry`），也是槽位 props（`sessionId`/`useSession`/`useInput`/`inputActions`）的来源 |
| `@deepseek-ai/dsh-client-locale` | `package.json` `peerDependencies`（与 `dsh.client.inject` 同名列） | `>=0.1.5-rc.1 <0.3.0-0` | 同上（同时是 i18n 取词源：`locale.register(ns, lang, dict)` / `locale.bind(ns)`，0.2.0-rc.1 实测签名未变） |
| ~~`@deepseek-ai/dsh-client-runtime`~~ | ~~`peerDependencies`~~ | **已移除（v4.2.5）** | 0.2 线**已淘汰**：npm 止于 `0.1.1-rc.2`，0.2.0-rc.1 的客户端启动图与 `app.asar` 内均无此包；其职责拆分到 `dsh-client-ui-slots`（槽位纯核心）、`dsh-client-store`（对象层）与 `dsh-client-ui-renderer`（`ctx.slots` 服务本体） |
| `@deepseek-ai/dsh-client-ui-renderer` | **不在** `peerDependencies`，由宿主自带 | 会话级槽位条目契约自 `0.1.2-rc.1` 起 | 更早渲染器只提供 `props.session` / `props.input` 形态 → 插件走旧形态回退兼容；两种形态都无 → ✨ 不渲染 |
| 客户端 `inputActions`（草稿写入能力） | 宿主 client 注入（能力判定，无版本号） | — | 无 `setDraft` → 增强结果不回写草稿（仅结果条目展示，撤回/取消同样静默跳过） |

说明：`package.json` `dependencies` 实测仅 `undici`（执行器副本由 `ensureExternalExecutor` 同步 `node_modules/undici`）；host 半部与执行器不声明 peerDependency。上表由 `package.json` `peerDependencies` 与 README「输入框工具行（✨）客户端契约」段落实读得出，改 peerDependency 或槽位契约时须同步本节。

**门禁口径（v4.2.5 实测·0.2.0-rc.1 起）**：DSH 在 profile 导入插件前读取插件 `package.json` 的 `peerDependencies`，**只**筛选名为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的条目，把**每一条**范围与**运行时版本**（`@deepseek-ai/dsh-app-boot` 自身 `package.json` 的 `version`，本机 = `0.2.0-rc.1`；**不是**按依赖名查表）比对：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；任一条不满足 ⇒ 整个插件被判不兼容并**拒绝加载**。不声明 `peerDependencies` 则完全不受检；`engines.dsh` 与 `dsh.manifestVersion` 官方明示**不强制**（纯作者声明）。豁免通道：profile 的 `compatibility.json`（精确 `包名@版本` × 精确 DSH 版本，由插件管理器 / `dsh plugin allow-version` 写入），**不跨版本继承**。→ v4.2.4 的 `^0.1.0-rc.6`（0.x 上等价 `>=0.1.0-rc.6 <0.2.0`）即在此被 0.2.0-rc.1 判死（实证：`docs/migration-dsh-0.2.0-rc1-report.md`）。

**`dsh.client.inject` 的真实作用（v4.2.5 更正）**：它是**包名排序提示**（官方定性 *Informational package-name dependencies, not Cordis service injection*）——列出的包其 factory 需先就位；名字若不在客户端启动图内**被静默跳过**（`if (dependency !== void 0)`），**没有任何阻断能力**（宿主侧排序只用 `dsh.client.external`）。**会阻断整插件加载的只有 `peerDependencies`**——本节旧版曾误写为「宿主缺失 → `dsh.client.inject` 不满足 → client 半部不注入」，2026-09-28 依 0.2.0-rc.1 源码更正。

---

## 5. 兼容性红线

1. 动态 Cordis 安装必须始终可用 → `plugin-host.js` / `lib/client.cjs` 保持单文件产物。
2. 所有 RPC 方法名不得随意变更；变更必须走 `protocolVersion`。
3. 配置迁移必须可回退，禁止静默丢失用户设置。
4. 多 profile（web/headless/自定义）必须继续支持。
5. 安装/更新必须走**受控通道**：一键更新仅接受 GitHub Release 的 npm pack tgz（固定仓库 `buildTarballUrl`）+ staging 目录内的本地 tgz（路径白名单校验）；v3.2.2 起安装为**直接解包复制到运行环境目录**（`System32\tar.exe` + 文件级覆盖，不再经 `dsh plugin add`/pnpm——规避操作运行中 profile 卡死，v3.2.1-r 根因修复）；禁止任意路径/任意命令执行安装。
