# 提示词优化 · 多会话状态隔离与状态机边界审核报告

> 审核对象：dsh-prompt-enhancer **v4.2.1**（client 半部 + host 半部）
> 审核动因：测试中发现「不同会话之间的提示词优化状态会互相干扰」
> 审核方式：逐行读码（第一轮 client 5 chunk + host 2 chunk）+ **10 条可复现审核用例**（`AUDIT-01…12`，内嵌既有测试基建，真跑真实 chunk）；**复核轮（2026-09-27 第二轮）**补读 `enhance-bar.js`（含 ClarifyPanel）/`enhance-menu.js`/`model-main-section.js` chunk 与构建产物 `lib/client.cjs`，对第一轮结论逐条复核——补正 F7、修正行号引用、新增 **F9/F10** 两条已复现缺陷
> 配套用例：`test/client-enhance-flow.test.cjs` 末尾「多会话隔离审核」段（`npm test` 现为 **282 用例 / 280 通过 / 2 todo / 0 失败**，todo 即 F1/F3 的缺陷证据；复核轮实测确认含退出码 0）
> 复现命令：`node --test test/client-enhance-flow.test.cjs 2>&1 | Select-String '\[审核\]'`
>
> **行号约定**：`src/**/*.js` 在仓库里是**单行字符串 chunk**（`module.exports = "…"`），文件本身无行号可言。本文所有 `文件:行号` 均指**解码后（`\r\n`→`\n`）的逻辑行号**，与「第一轮部分引用失准（enhance-button 偏差 ≈22 行、helpers 偏差 0–51 行）」的问题已在本复核轮全部对齐；为防再漂移，关键处同时给出锚点文本（可 `Select-String` 直查）。

---

## 一、结论速览

| 编号 | 结论 | 严重度 | 状态 |
| :-- | :-- | :-- | :-- |
| **F1** | **返回会话时结果被静默丢弃**：A 的增强在「已切走」期间完成 ⇒ 结果只暂存；切回 A 时若首帧草稿尚未回灌（空串/未同步/还是上一会话的陈旧草稿），消费 effect 直接判「用户已编辑」⇒ `phase='idle'`、`enhanced=''`、结果键删除；第二帧草稿回灌后**已无法回注** | **中** | **已确认**（AUDIT-05 todo 钉住） |
| **F2** | **切档位 = 全局清链**：在会话 A 里切优化模式 ⇒ `clearAllMemoryChains()` 把**所有**会话的链、已答澄清记录、`optimized` 标记与全部持久化键一并清掉（含未挂载会话的残键）。触发面**不止用户操作**——见 F10（启动期配置同步也会触发） | **中** | **已确认**（AUDIT-03；现为已文档化行为，但与「会话互不干扰」的用户预期正面冲突） |
| **F3** | **在途结果与清链竞态**：清链（切档位）之后到达的在途结果仍按「请求时刻的 config」入链 ⇒ 被清掉的轨迹**复活**（链=1 + 持久化键重现；fresh 在途时澄清键也会随终稿一并复活） | 低-中 | **已确认**（AUDIT-06 todo；需产品裁定） |
| **F4** | **活动会话是单值全局、且由挂载驱动**：`activeSessionId` 只有一个；登记=挂载/换 sessionId，注销=卸载且仅在「仍持有该 id」时清空。两个槽位实例并存时后挂载者胜；持有者卸载会把可见会话误判为「已切走」⇒ 结果只暂存不注入（叠加 F1 即成丢失）。另一面：**卸载重建实例后**，完成回调闭包里的 `draftRef/inputActions` 是**死实例的引用**（见 F4 补充） | **中** | 源码级确认（harness 无卸载钩子，未写成用例） |
| **F5** | **store 回收丢 `optimized`**：记忆关 + 结果已消费（`phase='idle'`、链空）时切走 ⇒ `releaseStoreIfIdle` 回收内存条目，回来重建后 `optimized=false` ⇒ 「重新优化」入口退化为「首次」（无持久化载体）。注意回收触发于**切换会话**（effect cleanup）与**卸载**两条路径，非仅卸载 | 低 | 已确认（AUDIT-09 现状记录） |
| **F6** | **组件态跨会话残留**：`menuOpen`（▾ 菜单开合）是组件 useState，不随会话切换复位 ⇒ 切到新会话后菜单仍开着（`prog` 进度对象有 effect 复位，无此问题） | 低 | 源码级确认 |
| **F7** | ~~死状态~~ **复核轮改写**：① `dsh.enhance.seen.<sid>` 键（**第一轮误写为 `dsh-enh-seen:`**，实际前缀见 constants.js 锚点 `SEEN_KEY_PREFIX`）确为**只写不读**（全 bundle 唯一命中即定义处）；② `lastDraft/setLastDraft/getLastDraft` **不是死状态**——`model-main-section.js`（设置页连通性测试耗时估算）读取 `(getLastDraft() || '').length`，第一轮「零读方」结论**撤回**。它仍是跨会话全局单值（读到的是「最后渲染过的那个会话」的草稿），属低危共享而非死代码 | 低 | 已改写（见键名/读方证据） |
| **F8** | **host 兜底键风险**：`sessionId` 缺失时 host 的 `enhance`/`cancel` 用 `'unknown'` 兜底 ⇒ 所有匿名请求共用 `(unknown, seq)` 键；且 `enhance/progress` 的兜底是 `''`——**三处兜底值不一致**。当前客户端在 `sessionId === undefined` 时不渲染按钮、不发请求，故不可达 | 低（当前不可达） | 源码级确认（复核轮补 progress 不一致项） |
| **F9** | **新增：结果消费逻辑存在两份实现且行为分叉**。`EnhanceButton` 与 `EnhanceBar` 各有一份「result 态草稿消费」effect，判据相近但**行为不同**：button 版丢弃时**删结果键**且有「draft===backup ⇒ 回注」分支；bar 版丢弃时**不删键**、**无回注分支**。两组件同槽区并存（conversation.input.right / .dock），**谁的 effect 先执行谁先消费**——bar 先行时结果键残留，残留键会在 store 释放重建后把 `phase` **复活为 result**（已丢弃的结果借尸还魂） | **中** | **已复现**（scratch 实测 + 构建产物核对；取决于宿主槽位 effect 顺序，宿主侧顺序未定） |
| **F10** | **新增：启动期 host 磁盘配置同步的模式跳变也会触发全局清链**。模式监听（`bindMemoryChainModeWatch`）绑定在 config 订阅上，基线 = 启动时 localStorage（或缺省）的 mode；`syncConfigFromHost` 的磁盘配置到达后 `notifyConfig` ⇒ 若磁盘 mode ≠ 基线（典型：动态端口下 localStorage 丢失、磁盘保存的是 expert），**无任何用户操作**即 `clearAllMemoryChains()` 清光所有会话的链与澄清键 | **中**（有前提条件，但该前提正是 v3.2.4 Issue #1 防御的场景） | **已复现**（scratch：磁盘 expert ⇒ 键全清；磁盘 standard 对照 ⇒ 不清） |

**已核实「无问题」的链路**（构建在对应用例之上，详见 §四）：

- 会话 A 在途时切到 B：A 的结果**不注入** B 的草稿、B 的 store/键零污染、两边 `seq` 独立（AUDIT-01）；
- 清链三触发中的「草稿非空→空」**只清当前会话**（AUDIT-02）；
- `seq` 隔离：两端各自 `seq=1` 在途，取消 B 只取消 `(sidB, 1)`，A 仍在途；host 侧 `progress`/`cancel` 均按 `requestKey(sessionId, seq)`（=`String(sessionId)+':'+String(seq)`，plugin-host.js）定位（AUDIT-10）；
- **store 回收后 `seq` 归零无害**（复核轮补充）：host 无跨请求的会话级长驻状态（`pending` 即用即删于 finally），新请求同键覆盖旧记录，不产生碰撞；
- 澄清态按会话隔离：A 澄清中切到 B，B 不继承题目、A 的题保留可续答（AUDIT-12）；
- 实例复用（渲染器换 sessionId prop）：B 的渲染只反映 B，A 的 store 不被 B 的操作改动（AUDIT-07）；
- 结果回注正常路径（草稿 === backup）工作正常（AUDIT-04）；
- 配置快照语义：`saveConfig` 走 `configState.value = {...old, ...patch}`（**整体替换**）⇒ `enhance()` 内捕获的 `config` 引用是请求时刻快照，完成回调里的 `config.memory/mode` 判定与请求一致（**注意：这是不变式，任何原地改嵌套对象的写法都会破坏它**——复核轮已全 bundle 扫描嵌套原地赋值，当前为 0 处）。

---

## 二、状态模型现状（读码结论）

**每会话一份（`sessionStores: Map<sessionId, store>`，helpers.js:63-123，锚点 `const sessionStores = new Map()`）**：
`phase`（idle/enhancing/result/clarify）、`backup`、`enhanced`、`error`、`seq`、`memoryRounds`、`optimized`、`clarify`、`clarifyAnswers`、`freshRun`、`freshAnswers`、`lastModel/fallbackUsed`、`listeners`。

**持久化键（四种，均按 `<sessionId>` 后缀隔离）**：
`dsh-enh-result:<sid>`（结果暂存 `{b,e}`）、`dsh-enh-memory:<sid>`（记忆链）、`dsh-enh-clarify:<sid>`（已答问答）、`dsh.enhance.seen.<sid>`（**只写不读·死键**，F7；注意是点分命名，与其余三键的连字符命名不同族）。

**全局单值（跨会话共享，干扰来源集中在这里）**：
`configState.value`（模式/记忆/预算等，全局设置，语义上应当共享）、`activeSessionId`（活动会话，单值，helpers.js:148-154）、`lastDraft`（**有一处读方**：设置页连通性测试耗时估算，读到「最后渲染会话」的草稿，F7）、组件内 `menuOpen/prog`（F6）、`memoryChainModeSeen`（模式监听基线，**F10 的干扰入口**）。

**订阅组件 ×3（复核轮补全）**：`EnhanceButton`（conversation.input.right）与 `EnhanceBar`/`ClarifyPanel`（conversation.input.dock）各自 `subscribe(sessionId)`，**每会话 listeners 可达 2–3 个**；三者均有 `[sessionId]` 的卸载/换会话 cleanup → `releaseStoreIfIdle`。

**生命周期**：懒创建（`storeFor`，首次渲染/调用时建，并从 localStorage 白名单恢复 result/memory/clarify 三键，fresh 字段不恢复）→ 组件 `subscribe`（会话级 listener）→ **切走（换 sessionId 的 effect cleanup）或卸载**时 `releaseStoreIfIdle`（**仅** `phase==='idle' && listeners.size===0 && error===null` 才回收——三组件全部离开才可能满足）。

---

## 三、逐条发现

### F1（中·已确认）返回会话时结果被静默丢弃

**链路**：A 发起增强 → 用户切到 B → A 完成（`away=true`，结果写 `dsh-enh-result:A`、`phase='result'`，不注入草稿）→ 用户切回 A → 组件首帧拿到的草稿是空串（宿主回灌有延迟/或回灌的是原文但时序晚于 effect）→ 消费 effect（enhance-button.js:84-98，锚点 `s.phase !== 'result'`；**bar 侧另有一份分叉实现，见 F9**）判定 `draft !== enhanced` 且 `draft !== backup` ⇒ 走 else 分支：`phase='idle'`、`enhanced=''`、`clearResultStore`（**结果键被删**）。第二帧草稿回灌为原文时，结果已不存在，`draft === backup` 的回注分支永远不会命中 ⇒ **用户看到「什么都没发生」**，且无法撤销/回注。

**实测**（AUDIT-05）：`首帧空草稿 ⇒ phase=idle enhanced="" 结果键=false 草稿写入=[]`；`第二帧回灌原文后 草稿写入=[]（已无法回注）`。

**触发形态（复核轮补全）**：不止「空串」——实例复用换 sessionId 的**首帧草稿若还是上一会话（B）的陈旧值**，同样 `≠enhanced 且 ≠backup` ⇒ 同一丢弃分支；凡「切回瞬间的 draft 不是 backup 也不是 enhanced」的一切瞬态都命中。

**根因**：把「草稿 ≠ backup」等同于「用户主动编辑过」，未区分**宿主草稿尚未回灌**（空串/陈旧/未同步）与**用户真实编辑**；且丢弃是**不可逆**的（删键）。

**建议**：① 首帧（或草稿为空且本会话有暂存结果）**不得消费**结果，改为「挂起」；② 判据加一条「仅在草稿非空且 ≠ backup 时才视为用户编辑」；③ 丢弃改为惰性——保留结果键，直到用户真正在草稿里输入内容；④ 若必须丢弃，至少保留链并把 `optimized` 维持为 true，让「继续/重新优化」入口不丢。**修复时必须同时覆盖 button/bar 两份消费 effect（见 F9），否则只修一半。**

### F2（中·已确认）切档位 = 全局清链（跨会话互相干扰的主形态）

**链路**：A、B 各有链（C 会话已释放只剩持久化键）→ 在 A 里切档位（▾ 菜单或设置页，两入口均经 `saveConfig` 写 `config.mode`）→ helpers.js:265-280 的 config 监听触发 `clearAllMemoryChains()`（246-263）：遍历**所有**内存 store（清 `memoryRounds/optimized/clarifyAnswers/freshRun/freshAnswers` + 删两把持久化键）**再** `sweepMemoryStoreKeys()/sweepClarifyStoreKeys()` 全前缀清扫。

**实测**（AUDIT-03）：`切模式后 A 链=0 B 链=0 A 澄清记录=0 A 澄清键=false C 持久化链键=false`。

**根因**：把「全局设置变化」与「本会话轨迹作废」画等号。原注释的意图是「顺带清扫**已释放**会话的 localStorage 残键」，但实现里 sweep 是全前缀删除，连**在用会话**的键也删了（尽管其内存态同时也被清了，故自洽但过度）。另注意：**触发面不止用户切档**——启动期配置同步的模式跳变同样触发（F10）；记忆开关切换（`saveConfig({memory})`）**不**触发（mode 未变，符合 D-1 设计）。

**建议**：① 主体改为**仅清当前会话**（用户改档位时所在会话）；② sweep 只针对 `sessionStores` 之外的「孤儿键」（这才是注释的原意）；③ 若产品坚持「档位变化 ⇒ 全部轨迹作废」，请在 UI 上明示（例如 ▾ 菜单模式行的 hint：「切换档位会清空所有会话的优化记忆」），否则用户会把「我切档后 B 的记忆没了」当成 bug。

### F3（低-中·已确认）清链后在途结果把轨迹写回（复活）

**链路**：A 在途（记忆开）→ 切档位 ⇒ 全链清空 → 在途结果到达 ⇒ `seq` 未被清链动过（守卫通过），完成分支用**请求时刻**捕获的 `config.memory/mode` 判定入链 ⇒ 新一轮被 push 回刚被清空的链并重新落键。

**实测**（AUDIT-06）：`在途结果到达后 链=1 optimized=true 链键=true`。

**复核轮补充**：非 fresh 在途请求的澄清问答在**请求时**就已并入全局并落键（清链会删掉，但完成回调不再重写，故澄清键不复活）；**fresh 在途**的终稿成功会把 `freshAnswers` 并入 `clarifyAnswers` 并 `saveClarifyStore`（helpers.js:528-534）⇒ **澄清键也复活**。复活面 = 链键（记忆开）+ 澄清键（fresh 在途）。

**建议**：引入**链世代（epoch）**：清链时 `s.chainEpoch++`，`enhance()` 在请求开始时快照 epoch，完成时若 epoch 已变则「结果照常应用、但不写链」（或按产品裁定：直接丢弃该轮结果并提示）。这也顺带解决「切档位后在途请求仍按旧档位上下文继续」的观感问题。

### F4（中·源码级确认）活动会话是单值全局 + 挂载驱动

**机制**：enhance-button.js:77-80（锚点 `setActiveSession(sessionId)`）`useEffect(..., [sessionId])`：挂载/换会话时 `setActiveSession(sessionId)`；卸载时**仅当** `getActiveSession() === sessionId` 才置 null。helpers.js:484（锚点 `const away = getActiveSession() !== sessionId`）用它算 `away`，`away===true` ⇒ 不注入草稿（仅暂存）。

**风险**：① 两个槽位实例并存（同一会话的多个挂载点、或宿主缓存面板）时「最后挂载者胜」，可见会话可能不是 active；② active 持有者卸载后 `activeSessionId=null`，此时**可见会话的完成也会被判「已切走」**⇒ 结果只暂存不注入（叠加 F1 的回注时序问题即变成用户可见丢失）；③ `away` 一个标志同时承担「不注入」与「跳过用户编辑检查」两件事，语义耦合。

**复核轮补充（死实例闭包）**：若宿主**卸载重建**按钮实例（而非复用换 prop），完成回调闭包里的 `draftRef/inputActions` 是**已卸载死实例**的引用——用户切回 A、新实例挂载、`activeSessionId===A` 时旧回调到达：`away=false`，但 `draftRef.current` 是死实例最后一帧的值（≈backup，恰使「用户已编辑」检查恒不触发），`safeSetDraft` 走的也可能是死实例的 actions。当前依赖「宿主 actions 是会话级稳定对象」这一未声明假设才不出错，脆弱且不可测。

**建议**：删除全局 `activeSessionId`，改为**实例本地**判据：在 `enhance()` 调用时快照 `sessionId`，完成回调里比较「本次渲染的 sessionId 是否仍等于快照」（组件已有该值：`props/useSession`），既不依赖挂载顺序，也不需要全局登记；若宿主确实可能把结果投给非当前会话，再用「宿主是否仍持有该会话的输入」判定。

### F5（低·已确认）store 回收丢 `optimized`

**链路**：记忆关 + 结果已消费（`phase='idle'`、`enhanced=''`、链空、`optimized=true`）→ 切走（**换 sessionId 的 effect cleanup**，三组件全部离开；或整组件卸载）→ `releaseStoreIfIdle` 回收 → 切回重建 ⇒ `optimized=false` ⇒ 主键显示「✨ 首次」而不是「重新优化」。

**实测**（AUDIT-09）：`同对象=false optimized=false phase=idle 链=0`。

**复核轮补充**：回收同样复位 `seq`（0 起）——已核实无害（host 无长驻会话状态，见 §一）；链非空（记忆开）的会话不受此影响（重建时链键恢复 ⇒ `optimized=true`）。

**建议**：把 `optimized` 纳入持久化（新键或并入结果键的元数据），或让 `releaseStoreIfIdle` 在 `optimized===true` 时不回收。严重度低（记忆关场景本来就「无上下文」，用户仍可点 ✨ 重跑）。

### F6（低·源码级确认）组件态跨会话残留

`menuOpen` 是 `useState`（enhance-button.js:58），effect 依赖里没有 `sessionId` ⇒ 切会话后 ▾ 菜单保持打开（内容读全局 config，值本身不错，但「上一个会话的操作残留到新会话」正是用户描述的干扰观感）。`prog`（进度对象）由 enhance-button.js:185-209 的 effect 在 `phase!=='enhancing'` 时复位，无此问题。

**建议**：`useEffect(() => setMenuOpen(false), [sessionId])`（或在会话切换时关菜单/关澄清面板）。

### F7（低·复核轮改写）死状态 → 半死状态

- **`dsh.enhance.seen.<sid>`**（helpers.js:125-135，`seenKey/writeSeen/clearSeen`；前缀定义在 constants.js `SEEN_KEY_PREFIX = 'dsh.enhance.seen.'`）：成功入链时写、清链时删，**从无读方**（全 bundle 固定串检索唯一命中即常量定义处；`getItem(seenKey` 零命中）。第一轮文档误写为 `dsh-enh-seen:`——该写法实为**测试桩**传入的假前缀（test/client-enhance-flow.test.cjs loadHelpers 第 54 行），与生产前缀不同；因键只写不读，此偏差当前无行为影响，但复核时引用键名应以 constants.js 为准。确认为死键，建议删除。
- **`lastDraft/setLastDraft/getLastDraft`**（state.js:361-367）：第一轮断言「零读方」**有误，撤回**。读方在 `model-main-section.js`（设置页「测试」入口的预计耗时估算，`(getLastDraft() || '').length`）。它是跨会话全局单值：每个 EnhanceButton 渲染都 `setLastDraft(draft)`（enhance-button.js:68），多实例并存时「最后渲染者胜」——设置页读到的是最后渲染会话的草稿长度。当前单实例模型下即「当前会话」，属低危共享；不建议删（有真实消费方），但若做 F4 的多实例改造，此处应改为显式传值。

### F8（低·潜在）host 匿名兜底键

enhance-handlers.js:414（`enhance`）与 455（`cancel`）`sessionId` 缺失时兜底 `'unknown'`，而 `pending` 的键是 `requestKey(sessionId, seq)`（plugin-host.js，格式 `String(sessionId)+':'+String(seq)`）⇒ 若客户端漏传 `sessionId`，所有匿名请求共享 `(unknown, seq)` 命名空间，`cancel`/`progress` 可能互相命中。**复核轮补充**：`enhance/progress`（enhance-handlers.js:36）同一兜底用的却是 `''`——三处不一致，意味着「匿名 progress」永远查不到「匿名 enhance」的记录。当前客户端在 `sessionId === undefined` 时不渲染按钮、不发请求（enhance-button.js:211 `return null`），故**当前不可达**；但后端改造/新入口若复用该 handler 就会踩到。

**建议**：host 侧对缺失 `sessionId` 直接 `BAD_ARGS`（rpc-schema 已有 `required: ['sessionId', 'text']`，「unknown」兜底与之矛盾），或把兜底键改为每次请求唯一（如 `anon:<uuid>`）。

### F9（中·复核轮新增，已 scratch 复现）结果消费逻辑双实现且行为分叉

**事实**：同一「result 态草稿消费」存在两份 effect——

| | EnhanceButton（enhance-button.js:84-98） | EnhanceBar（enhance-bar.js:27-45） |
| :-- | :-- | :-- |
| 触发 | `[draft, sessionId]`，`phase==='result'` 且 `draft∉{enhanced, backup}` | 同左（判据等价，含 `backup!==''` 语义相同） |
| 回注 | `draft===backup` ⇒ `safeSetDraft(enhanced)` 重应用 | **无此分支** |
| 丢弃 | `phase='idle'` + `enhanced=''` + **`clearResultStore` 删键** | `phase='idle'` + `enhanced=''`，**不删键**（错误提示组件的对称处理，漏了键） |
| clarify 作废 | 仅「草稿清空」路径（enhance-button.js:131-137） | 「草稿 ≠ backup」即作废（bar 版更宽，两份取并集） |

两组件分别挂在 conversation.input.right 与 conversation.input.dock，切回会话/草稿变化时**两份 effect 都满足触发条件**，先执行者完成消费（`phase→idle`）后另一份因 phase 门提前 return——**实际删不删键取决于宿主槽位在 effect 执行序中的先后**，插件侧不可控、既有测试（只挂 button）也无法覆盖 bar 先行的情形。

**scratch 实测**（bar 单独驱动，`C:\Users\W\.zcode\cli\scratch-audit\bar-consume-divergence.cjs`）：
`bar 首帧空草稿 ⇒ phase=idle enhanced="" 结果键=true（button 同场景为 false，见 AUDIT-05）`；
`切走再切回（触发 release+重建）⇒ phase=result backup="原稿" optimized=true`——**残留键把已丢弃的结果复活成待消费态**（若此刻草稿恰为 backup，回注分支会把用户已放弃的结果重新写进草稿；通常则是再次被消费 effect 丢弃，键长期滞留到下次 enhance/undo/cancel）。构建产物 lib/client.cjs 已核对：两份判据都在，bar 分支邻近确无 `clearResultStore`。

**建议**：把「结果消费」收敛为 helpers 里的单一函数（如 `consumeResult(sessionId, draft)`），两个 effect 只做调用；或至少对齐两份行为（bar 补删键/回注）。修复 F1 时必须两份一起改。

### F10（中·复核轮新增，已 scratch 复现）启动期配置同步的模式跳变触发全局清链

**链路**：state.js 装载时 `loadConfigFromStorage()` + `syncConfigFromHost()`（异步）；随后 helpers 装载并 `bindMemoryChainModeWatch()`，**基线 = 当时 configState.value.mode**（localStorage 值，缺失则缺省 `standard`）。磁盘配置（`$DSH_HOME/dsh-prompt-enhancer.config.json`，跨端口共享）到达后 `configState.value = sanitizeV2(磁盘)` 并 `notifyConfig()` ⇒ 监听看到 mode 跳变 ⇒ `clearAllMemoryChains()`。

**触发条件**：启动时「localStorage 侧 mode ≠ 磁盘 mode」。典型即 **v3.2.4 Issue #1 防御的场景**——DSH Desktop 动态端口 ⇒ 新 Origin 下 localStorage 为空（基线=standard），磁盘保存的却是用户真实的 expert/lite ⇒ **一启动、零操作，全会话链 + 澄清键清光**。

**scratch 实测**（`C:\Users\W\.zcode\cli\scratch-audit\m1-startup-sync-wipe.cjs`，按 constants→state→helpers 注入序拼作用域，预置两会话链键）：
磁盘 `expert`：`同步前键=[memory:A, memory:B, clarify:A] → 同步后=[]`（复现）；
磁盘 `standard`（对照组）：键全部保留。

**根因**：F2 的「mode 跳变 ⇒ 全局清链」监听**没有区分「用户切档」与「启动同步补齐」**——后者不是设置变更，只是持久化配置的迟到到达。

**建议**：短期最简——`syncConfigFromHost` 成功落值时置「静默旗」，模式监听在该旗有效期间只更新 `memoryChainModeSeen` 基线、不触发清链；与 F2 的「只清当前会话」改造合并处理则天然消解。

---

## 四、链路实测矩阵

| # | 链路 | 用例 | 实测结论 |
| :-- | :-- | :-- | :-- |
| 1 | A 在途 → 切 B → A 完成 | AUDIT-01 | ✅ 隔离正确：A 只暂存（结果键✓、链+1）、不写草稿；B 全字段零污染 |
| 2 | B 草稿「非空→空」（手动清空/发送） | AUDIT-02 | ✅ 只清 B 的链与键；A 的链/optimized/键保持 |
| 3 | 在 A 切档位（全局 config） | AUDIT-03 | ⚠️ **A、B、C（未挂载）全部被清**（链 + 澄清记录 + 持久化键） |
| 4 | 切回 A，草稿 === backup | AUDIT-04 | ✅ 自动回注结果、结果键保留 |
| 5 | 切回 A，首帧草稿为空/未回灌 | AUDIT-05 | ❌ **结果被丢弃**（不可逆，第二帧无法回注） |
| 6 | A 在途 + 切档位 | AUDIT-06 | ⚠️ 清链后到达的结果**复活**链并落键 |
| 7 | 实例复用 A→B | AUDIT-07 | ✅ B 只反映 B；A 的 store 零改动 |
| 8 | 切走（卸载）再回来（记忆关·结果已消费） | AUDIT-09 | ⚠️ `optimized` 丢失 → 入口退化「首次」 |
| 9 | A、B 各自 `seq=1` 在途 → 取消 B | AUDIT-10 | ✅ 仅取消 `(sidB,1)`；A 保持 in-flight；host 双 RPC 均按 `(sessionId, seq)` 定位 |
| 10 | A 澄清中 → 切 B | AUDIT-12 | ✅ B 不继承题目、A 的题保留 |

**复核轮补充验证（scratch / 静态，未入仓库用例）**：

| # | 链路 | 方式 | 实测结论 |
| :-- | :-- | :-- | :-- |
| 11 | 启动：localStorage 无 config、磁盘 mode=expert | scratch（F10） | ❌ 零用户操作，全部链/澄清键被清；磁盘=standard 对照组保留 |
| 12 | bar 消费 effect 单独执行（首帧空草稿） | scratch（F9） | ⚠️ 结果丢弃但**键残留**（button 版为删键）；切走再回 ⇒ `phase=result` 复活 |
| 13 | 构建产物一致性 | lib/client.cjs 核对 | ✅ 两份消费判据均在产物中；bar 分支邻近无 `clearResultStore`；嵌套 config 原地赋值 0 处（快照不变式成立） |
| 14 | `dsh.enhance.seen.` 读方 / `getLastDraft` 读方 | 全 bundle 固定串检索 | seen 前缀唯一命中=定义处（死键）；`getLastDraft` 在 model-main-section 有读方（F7 改写依据） |

---

## 五、给后端优化与测试的建议（按优先级）

**P0（会丢用户数据，先修）**
1. F1 结果丢弃：首帧/空草稿不得消费结果；丢弃改惰性且不删键。**实现须同时覆盖 button/bar 两份消费 effect（F9），建议先收敛为 helpers 单函数。**
2. F3 链世代 epoch：清链后在途结果不入链（或不应用），消除「复活」与「旧上下文继续跑」。

**P1（用户可感知的跨会话干扰）**
3. F2 清链作用域：主体只清当前会话；sweep 只清孤儿键。若坚持全局，必须在 UI 明示。
4. F10 启动同步静默旗：磁盘配置补齐不算「切档」，不得触发清链（可与 3 合并修）。
5. F4 去掉全局 `activeSessionId`，改为实例本地「sessionId 快照比对」判注入。

**P2（体验/健壮性）**
6. F5 `optimized` 持久化或抑制回收；F6 会话切换复位 `menuOpen`；F7 删除 seen 死键（`lastDraft` 保留但注意多实例语义）；F8 host 缺失 `sessionId` 直接报错并统一三处兜底值。
7. 其余契约建议：为「in-flight 期间配置变化」定义明确语义（当前为请求时刻快照，已在 §一 记录为不变式，请在改造中保持）；新增入口若绕过 `enhance()`，必须复用同一套 store/键/世代语义。

**建议补的回归用例**（当前 todo 转正 + 新增）：F1 首帧空草稿不丢结果（AUDIT-05 转正）；F3 清链后结果不入链（AUDIT-06 转正）；F2 只清当前会话；F4 双实例挂载/卸载下的注入判定；F6 切会话关菜单；**新增 AUDIT-13（bar 消费 parity：丢弃必须删键/回注行为与 button 一致，或收敛单函数后删此用例）、AUDIT-14（启动 host 同步 mode 跳变不触发清链）、AUDIT-15（F4 死实例：卸载重建后完成回调不依赖死 `draftRef/inputActions`）**。

---

## 六、审核方法与可复现命令

```powershell
# 1) 审核用例（10 条，内嵌既有 client 测试基建；含 2 条 todo 缺陷证据）
node --test test/client-enhance-flow.test.cjs 2>&1 | Select-String '\[审核\]|^ℹ (tests|pass|fail|todo)'

# 2) 全量回归（复核轮实测：282 用例 · 280 通过 · 0 失败 · 2 todo · 退出码 0）
npm test

# 3) 上游事实源锚点（host 侧 (sessionId, seq) 定位；requestKey 定义在 plugin-host.js）
Select-String -Path src/host/enhance-handlers.js -Pattern 'requestKey\(sessionId, seq\)'
# F9 锚点：bar 版消费判据（产物同源）
Select-String -Path lib/client.cjs -Pattern "phase === 'result' && draft !== s.enhanced"
# F7 锚点：seen 前缀（注意点分命名）
Select-String -Path src/client/constants.js -Pattern 'SEEN_KEY_PREFIX'

# 4) 复核轮 scratch 复现（F9/F10，脚本在会话临时目录，未入仓库；配方如下）
#    F10：按 constants→state→helpers 注入序拼接解码 chunk（同 bundle 顺序），localStorage 预置
#         dsh-enh-memory:* 两键且无 config 键，host 桩 config/get 返回 {ok:true,config:{version:2,mode:'expert'}}
#         → 微任务 flush 后键应全清（mode:'standard' 对照组保留）。
#    F9 ：解码 enhance-bar chunk + 迷你 React（含 effect cleanup 语义）驱动 EnhanceBar：
#         预置 phase='result'+结果键，首帧 draft='' → phase=idle 且结果键仍在；换 sessionId 触发
#         release 后切回 → storeFor 恢复 phase='result'（复活）。
```

**审核边界（未覆盖的部分）**：① 组件卸载/双实例并存的注入判定只有源码级结论（现有 harness 无卸载钩子，未写成用例；scratch 已补「换 sessionId 触发 cleanup」的最小语义，但仍是单实例驱动）；② 真实宿主渲染器在会话切换时究竟是「复用实例」还是「卸载重建」由宿主决定，本文以「复用实例换 sessionId」为主模型（代码注释与既有用例同此假设），并为「并存」「卸载重建」情形给出 F4/F9 风险；③ 未覆盖多标签页/多窗口同会话并发（同一 `sessionId` 在两个页签各跑一轮，per-store 的 `seq` 各自从 0 开始 ⇒ 可能撞 `sid:seq` 键，需宿主侧 sessionId 唯一性或服务端 seq 生成规则兜底）——**建议纳入下一轮审核**；④ F9 的「bar 先行」顺序取决于宿主槽位 effect 执行序，插件侧无法固定，修复前建议以「两份行为对齐」为验收（而非依赖顺序）。
