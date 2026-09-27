# v4.2 实施规范：双键按钮状态机（从零重新优化 + 撤销放开）+ 小三角箭头方向切换动画

> 决策来源：`docs/提示词增强对话记录3.md`（用户与方案轮定稿）——双键状态机、「重新优化 = 新开对话式从零（**输入不带上下文、结果照常入链**）」、「撤销放开且链非空时可连环撤销」、「已改 + 记忆开没有重新优化入口（先撤销再重跑）」。
> 本轮版本 **4.2.0**（新功能，minor）。发布（提交/推送/Release）**不在本轮**，待用户自测通过后另行指令。
> 本文件是**唯一权威接口契约**：所有实现者按此对齐，不得自行改口径；发现契约矛盾 → 立即上报 Lead，不得自行折中。

## 一、状态机（定稿）

记号：`D` = 当前草稿正文（`draftBodyOf` 剥斜杠命令前缀）；`L` = 链末轮 `output`（有链）或最近优化结果正文（`s.enhanced` 剥前缀，无链时）；`memoryOn` = `configState.value.memory === true || configState.value.mode === 'expert'`（专家档固定记忆，v4.4/V6 既有口径）。

| 状态 | 主键 | 左侧副键 | 点击语义 |
| :-- | :-- | :-- | :-- |
| 首次（`!optimized`） | ✨ + 模式短标签 | 隐藏 | 现有 enhance |
| 优化中 / 澄清中 | 进度 / 等待作答 | 隐藏 | 现有 cancel / clarifyCancel |
| `optimized && D === L`（result 或 idle） | **「撤销优化」**（文字） | **⟳** | 主 = undo；副 = **fresh**（从零单次） |
| `optimized && D !== L`，`memoryOn` | **「继续优化」**（文字） | **↺** | 主 = 普通 enhance（链 + 澄清记录）；副 = undo |
| `optimized && D !== L`，非 `memoryOn` | **「重新优化」**（文字） | **↺** | 主 = **fresh**（无链无澄清记录，天然从零）；副 = undo |

- 副键仅在 `optimized === true && phase ∈ {result, idle}` 渲染；`L === null` 时按「已改」处理（保底，实际不可达）。

### 1.1 r2 修订（独立验证反例 D-1/D-2 裁定后冻结，**优先于 §3.1/§3.2 的旧表述**）

**① L 改为「最近结果优先」**：
`L = s.enhanced !== '' ? draftBodyOf(s.enhanced) : (链非空 ? 链末轮 output : null)`。
理由：**D-1**（记忆开关切换不清链 ⇒ 链尾可能早于最近一次结果，主/副键双 undo、⟳ 入口消失、撤销回退到更旧草稿）；**D-2**（模型输出本身以 `/cmd ` 开头时链尾未剥前缀而 D 恒剥 ⇒ 「未改」失真、结果刚落就显示「已改」行）。
同源性不受影响：**记忆开时每轮都入链**，故 `s.enhanced` 与链末轮 output 恒同时更新、二者等价；只有「记忆关轮次 / 混合态」下才分叉，而那时 host 侧 `memoryActive === false` 本就不消费链（不会出现「UI 说继续、host 不注入继续指令」）。

**② 主键与副键判据同源**：主键 undo 分支与副键统一用 `phase === 'result' || isUntouched` 形式的 `isUndoState = phase === 'result' || isUntouched`（旧实现主键用 `phase === 'result'`、副键用 `isUntouched` ⇒ 存在「主=撤销、副=撤销」且 ⟳ 消失的双 undo 窗口）。

**⚠ 析取项 `phase === 'result'` 是承重结构，不是纯兜底**（初版此处写「改 ① 后 phase === 'result' 必然蕴含 isUntouched」——**该断言已被独立验证证伪**）：result 态期间草稿未必等于 `draftBodyOf(s.enhanced)`，实测三格——(B) 刷新首屏结果键已恢复而草稿尚未回灌（draft=''）；(C) 用户刚编辑但 effect 尚未把 phase 转 idle 的一帧；(D) 服务端回灌草稿 === backup（下一帧才自动重新应用结果）。三格中 `isUntouched=false` 而 `phase==='result'` ⇒ 主键仍须是**可点的「撤销优化」**（撤销能把 backup 找回来）；若删掉析取项（独立验证变异 m8），B 格主键退化为 **disabled 的「继续优化」**（title `titleBusyInput`）、副键变 ↺ ⇒ 刷新后本可一键撤销的能力丢失。故 §五 用例必须显式覆盖「result 且 D ≠ L」行。。

**③ undo 回退点重定义（替换 §3.1 的旧规则）**：

```js
const last = s.memoryRounds.length > 0 ? s.memoryRounds[s.memoryRounds.length - 1] : null;
const live = typeof s.enhanced === 'string' && s.enhanced !== '' ? s.enhanced : '';
let restore = '';
let pop = false;
if (live !== '') {                    // 最近一次运行的结果仍在（未被编辑/撤销消费）⇒ 撤的就是它
  restore = s.backup !== '' ? s.backup : (last ? last.input : '');
  pop = !!last && typeof last.output === 'string' && (live === last.output || splitCommand(live).body === splitCommand(last.output).body); // 身份 = 链末轮 output 与 live 对齐（r3：不再用 backup 文本相似性代理）
} else if (last) {                    // 连环撤销 / 刷新兜底
  restore = last.input; pop = true;
} else {
  restore = s.backup;
}
if (restore === '') return;           // 不动作
// 其余照旧：safeSetDraft → 若 pop 则 pop + saveMemoryStore → s.optimized = memoryRounds.length > 0
```

覆盖矩阵（全部需实测用例，见 §五）：result（记忆开 / 记忆关）、idle 已改、3 轮连环撤销、刷新兜底（`backup===''`）、混合态（链尾 ≠ 最近结果）、空链空 backup 零副作用、result 态 `backup` 与链末 `input` 不一致。

**③-b r3 修（pop 身份判据）**：初版用「`splitCommand(backup).body === last.input`」当身份代理，独立验证给出反例 **S20（文本巧合误弹）**——记忆开 X→O1 ⇒ 关记忆流（不清链）⇒ 把草稿改回**逐字相同的 X** ⇒ 点「重新优化」→ O2（backup=X）⇒ 点撤销：回退值正确（X），但链 `[X→O1]` 被误弹、持久化链键被删、`optimized` 复位（对照组改成 Y 则不弹，差异纯由文本巧合决定）。改为**live 与链末轮 output 对齐**（两侧都剥前缀，兼容 D-2 形态 + 保留精确相等快路），语义回到「链末轮确属本轮才 pop」。

**④ 已知残留（不改，仅文档化）**：混合态下链尾仍是旧轮（记忆关轮次按设计不入链）⇒ 若用户事后把记忆流**重新打开**再点「继续优化」，host 的 diff 基准取链尾（旧轮）而草稿是最新结果 → 会得到一个偏大的「本轮修改」摘要。彻底修它需要「切记忆开关也清链」或「记忆关轮次也入链」，两者都超出本轮用户决策范围。

**⑤ `L === null` 实为可达**（独立验证 Q-1）：记忆关 + 已优化 + 已改 + 点「重新优化」后在途中取消 ⇒ `optimized=true / enhanced='' / 链空` ⇒ 落「已改」行（主=重新优化 + 副=↺），行为正确、无需特判；本节起 §一 行 19「保底，实际不可达」的表述**作废**。
- 连环撤销：撤销后链非空 → 落「`D !== L`」行 → 副键 ↺ 仍在；撤到链空 → `optimized = false` → 回「✨ 首次」。

## 二、host 侧：**零改动**（已核实，附证据）

`src/host/enhance-handlers.js` analyze 阶段（现文件第 87-132 行）：

- 请求不带 `memory` → `baseRounds = []` → `hasMemory = false` → `isContinuation = memoryActive && baseRounds.length > 0 && …` **恒 false** ⇒ 不注入 `CONTINUE_PROMPT`、不注入「本轮修改」摘要；
- assemble 阶段：**实际走 `else` 单条 user 消息分支**——`pure.js:79-81` 的 `shouldInjectMemory = memoryOn && hasMemory` 双门 ⇒ 不带 memory 时 `baseRounds=[]` ⇒ `hasMemory=false` ⇒ `memoryActive` 恒 false（独立验证指出：§2 初版写的 `buildChatMessages([], …)` 路径在 `memoryActive=true` 且 rounds 为空时**不可达**；即便人为构造，`pure.js:224` 也必然补一条 final user 消息，结论相同）。证据正文仅含本次 `originalDraft`；
- 请求不带 `answers` → `clarifyAnswers = []` ⇒ 不进证据正文 JSON、不注入澄清参考消息；专家档仍照常解析澄清信号（可再次弹卡，属「新开对话」语义的预期结果，用户已确认）；
- 结果入链是 **client 侧**行为（`enhance` 成功分支 push），host 不持有链。

结论：v4.2 的「从零重新优化」由 client 实现（请求不带 `memory`/`answers`），**host 不需要任何改动**；但必须补 host 级测试证明上述三条（见 §五）。

## 三、client 接口契约（冻结）

### 3.1 `src/client/helpers.js`

- **store 新字段**：`freshRun: false`、`freshAnswers: []`（**不持久化**——与「澄清卡刷新作废」一致；全局 `clarifyAnswers` 才是跨刷新存活的那份）。
- **`enhance(sessionId, draft, inputActions, draftRef, clarifyOpts, fresh)`** 新增第 6 参 `fresh`（boolean，可省略）：
  1. `fresh === true`：`req.memory` **不带**；`req.answers` 仅在 `s.freshAnswers` 非空时携带（值 = `freshAnswers`），**全局 `s.clarifyAnswers` 本次既不携带也不清空**；置 `s.freshRun = true`；本轮 `clarifyOpts.answers` 的 `roundAnswers` **不并入 `s.clarifyAnswers`、不 `saveClarifyStore`**，而是并入 `s.freshAnswers`（封顶 `slice(-9)`）。
  2. 非 fresh：现有行为逐字不变（`req.answers` 取 `s.clarifyAnswers`；`roundAnswers` 并入并持久化），并置 `s.freshRun = false`。
  3. 澄清续跑沿袭 fresh：`clarifyOpts` 存在且 `s.freshRun === true` ⇒ 上述 1 的口径继续（不带 memory、answers 取 freshAnswers、新答并入 freshAnswers）；零作答降级 skip 逻辑不变。
  4. **写链照常**：终稿成功分支的入链条件 / 轮次结构**不得改动**（`fresh` 不参与判定）。
  5. 终稿成功：`s.clarifyAnswers = (s.clarifyAnswers || []).concat(s.freshAnswers || []).slice(-9)` → `saveClarifyStore` → `s.freshAnswers = []`、`s.freshRun = false`。
  6. 失败 / 网络失败：**保留** `freshRun`/`freshAnswers`（重试仍 fresh）；已入库澄清记录照旧不清。
  7. 澄清信号分支：**保留** `freshRun`/`freshAnswers`（续跑仍 fresh）。
  8. 结果被丢弃分支（增强中用户改了草稿）：本轮 fresh 会话作废 → `freshRun = false`、`freshAnswers = []`。
  9. `cancelEnhance`：同上作废（`freshRun = false`、`freshAnswers = []`）。
- **`undo(sessionId, inputActions)` 放开**：
  - 前置：`phase === 'result' || (phase === 'idle' && s.optimized === true)`，否则 return；
  - 回退草稿：**按 §1.1③ 的 r2 规则**（最近结果 live 优先 + 条件弹链）；`restore === ''` 则 return 不动作；
  - pop 一轮（有则）→ `saveMemoryStore`；`s.optimized = s.memoryRounds.length > 0`；
  - 其余照旧（`phase = 'idle'`、`enhanced = ''`、`error = null`、`clearResultStore`、`notify`）+ 清 `freshRun`/`freshAnswers`。

### 3.2 `src/client/components/enhance-button.js`

- 判定**只算一次**（提升到 `const s = …` 之后、分支之前，替换原 ~283-287 行的内联重算与 ~313-318 行的渲染期二次重算）：
  `lastOutput`（链末轮 output ▸ `s.enhanced` 剥前缀 ▸ `null`）、`optimized`、`isUntouched = optimized && lastOutput !== null && draftBodyOf(draft) === lastOutput`、`isModified = optimized && !isUntouched`、`memoryOn`。
- 主键（`phase === 'result'` 与 `phase === 'idle' && isUntouched` 共用同一产物）：`onClick = undo`、`title = t('titleResult')`、文案 `t('result')`、`cls += ' dsh-enh-btn-result dsh-enh-btn-text dsh-enh-btn-center'`、`disabled = false`。
- 主键 `isModified && memoryOn`：`onClick = enhance(…)`（普通）、`t('btnContinue')`/`t('titleContinue')`、`cls += ' dsh-enh-btn-text dsh-enh-btn-center'`、`disabled = !guardPasses(draft, input)`。
- 主键 `isModified && !memoryOn`：`onClick = enhance(sessionId, draft, inputActions, draftRef, undefined, true)`（**fresh**）、`t('btnRedo')`/`t('titleRedo')`、类同上行、`disabled = !guardPasses(draft, input)`。
- **副键**（`optimized && (phase === 'result' || phase === 'idle')` 才渲染）：`button.dsh-enh-aux`，内含 `span.dsh-enh-aux-icon`，字形 `isUntouched ? '⟳' : '↺'`；
  `onClick`：`isUntouched` → 从零（`if (!guardPasses(draft, input)) return; enhance(sessionId, draft, inputActions, draftRef, undefined, true)`）；否则 → `undo(sessionId, inputActions)`；
  `title`/`aria-label`：`t('auxRedo')` / `t('auxUndo')`；`tabIndex: -1`。
- 组合体渲染顺序：`.dsh-enh-split` 的子元素 = `[aux, main, EnhanceMenu]`（aux 为 null 时 React 忽略）。
- **不得破坏**：`main` 仍是 `button` 且带 `ref: mainRef` / `aria-label: t('enhanceButton')`；`menuOpen` 受控与 `anchorRef` 不变；空输入分支的 `setMenuOpen` 邻近契约（`if (empty) {` 后 ≤500 字符内出现 `setMenuOpen((v) => !v)`）；✨ 饱和度判定（`dsh-enh-icon-dim`）逐字不变。

### 3.3 `src/client/components/enhance-menu.js`

- ▾ 触发器（现 ~554 行的裸文本 `'▾'`）包一层 caret span：`React.createElement('span', { className: 'dsh-enh-menu-caret', 'aria-hidden': true }, '▾')`；触发器上的 `aria-expanded`（`open ? 'true' : 'false'`）**保持不变**——它是动画的唯一状态源，**不新增状态/类名切换**。

### 3.4 `src/client/styles.js`（新增片段，逐字使用）

```css
// v4.2（用户需求·双键按钮）：左侧副键（⟳ 从零重新优化 / ↺ 撤销优化）——配方镜像 ▾ 触发器
// （.dsh-enh-menu-trigger）：28px 高 / min-width 20px / 24px 胶囊圆角 / label-secondary 色 /
// hover 交互底色 / focus-visible 品牌描边；左侧无宿主内边距需抵消，故不加负 margin。
'.dsh-enh-aux{height:28px;min-width:20px;padding:0 4px;margin-right:-2px;justify-content:center;border:none;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;transition:background-color .15s ease}',
'.dsh-enh-aux:hover{background:var(--dsw-alias-interactive-bg-hover)}',
'.dsh-enh-aux:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
// 图标字形（⟳/↺）独立 span：便于与 ✨ 视觉重量对齐；语义由按钮 title/aria-label 承担
'.dsh-enh-aux .dsh-enh-aux-icon{display:inline-block;font-size:13px;line-height:16px}',

// v4.2（用户需求·图一~图四）：小三角箭头方向切换动画——展开态旋转 180°（▾ → ▴），180ms ease；
// 状态源 = 触发器上既有的 aria-expanded（enhance-menu.js / marquee-select.js 早已带着它），零新增状态。
'.dsh-enh-menu-caret{display:inline-block;transform-origin:center;transition:transform .18s ease}',
'.dsh-enh-menu-trigger[aria-expanded="true"] .dsh-enh-menu-caret{transform:rotate(180deg)}',
```

chip select 箭头：给既有基础规则补 `transition:transform .18s ease`（`.dsh-plg-mselect-arrow`，现文件 135 行），并新增两条展开态规则（基础规则带 `translateY(-50%)`，必须显式带上）：

```css
'.dsh-plg-mselect-trigger[aria-expanded="true"] .dsh-plg-mselect-arrow{transform:translateY(-50%) rotate(180deg)}',
'.dsh-plg-params-group .dsh-plg-mselect-trigger[aria-expanded="true"] .dsh-plg-mselect-arrow{transform:rotate(180deg)}',
```

（`.dsh-plg-params-group` 作用域内基础规则是 `transform:none;position:static`，故该作用域用 `rotate(180deg)`；两条规则的选择器权重 0-3-0 / 0-4-0 均高于基础规则的 0-1-0 / 0-2-0。）

降低动效偏好（**实发形态·冻结**）：不新增第二个媒体块，而在既有第 39 行块内扩展——

```css
@media (prefers-reduced-motion: reduce){.dsh-enh-spin{animation:none}.dsh-enh-menu-trigger .dsh-enh-menu-caret{transition:none}.dsh-plg-mselect .dsh-plg-mselect-trigger .dsh-plg-mselect-arrow{transition:none}}
```

（媒体块位于文件前部，而两条 transition 声明在 ~135 行与副键区、同权重且后出现 ⇒ 裸类选择器会被源码顺序反超而失效；故块内用 0-2-0 / 0-3-0 的祖先作用域选择器压过 0-1-0 基础规则。reduced-motion 下仍会翻转方向，只是不做过渡动画。）

### 3.5 `src/client/i18n.js`（ZH/EN 必须成对，键数相等）

| 键 | ZH | EN |
| :-- | :-- | :-- |
| `auxRedo` | 从零重新优化：本次不带记忆上下文（类似新开对话） | Re-optimize from scratch (no memory context this run) |
| `auxUndo` | 撤销优化：恢复本轮优化前的草稿 | Undo: restore the draft from before this optimization |
| `titleRedo`（**改文案**） | 重新优化：从零重跑（本次不带记忆上下文） | Re-optimize from scratch (this run carries no memory context) |

`btnRedo`（「重新优化」）与 `btnContinue`（「继续优化」）文案不变。

## 四、文件写者分工（严格独占）

| 文件 | 写者 |
| :-- | :-- |
| `src/client/helpers.js` | sm-core |
| `src/client/components/enhance-button.js` | sm-button |
| `src/client/styles.js`、`src/client/i18n.js`、`src/client/components/enhance-menu.js` | ui-css |
| `test/client-enhance-flow.test.cjs` | sm-tests |
| `docs/**`、`README.md`、`README.en.md`、`CHANGELOG.md`、`release-notes/4.2.0.md`、`package.json` | Lead |
| `plugin-host.js`、`lib/client.cjs`（构建产物） | **仅 Lead**，等所有写者停手后统一重建 |

分片编辑一律用 `node %TEMP%\dsh-dec420\chunk-edit.mjs apply <rel> <oldFile> <newFile> [count]`（见工具头注释）；改完必须 `check` 得 `ROUNDTRIP_OK`。**禁止**直接对物理单行分片做字符串替换，**禁止**运行 `npm run build` / `npm test` / `npm run gate`（Lead 统一执行）。

## 五、测试与验收清单

`test/client-enhance-flow.test.cjs`（sm-tests 唯一写者）：

1. 重写 `V4 按钮三态` 为 **V4.2 双键状态机**：首次 / result（主=撤销 + 副 ⟳）/ 未改 idle（主=撤销 + 副 ⟳）/ 已改 + 记忆开（主=继续 + 副 ↺）/ 已改 + 记忆关（主=重新 + 副 ↺）/ 改回原样（回 撤销 + ⟳）；
2. 重写 `V4 按钮三态·无链回退`（记忆关 lite/standard：链空但 `s.enhanced` 在 → 基准 = 最近结果正文）；
3. `MEM-07 undo` 扩写：result 态 undo 回本轮起点（前缀保留）+ **idle 态 undo 放开** + 连环撤销（每步回该轮 `input`，链空后 `optimized=false`）+ 刷新兜底（`backup===''` 时取 `last.input`）+ 空链空 backup 不动作；
4. **fresh 语义**（新增）：`⟳`/`重新优化` 请求断言（**无 `req.memory`**、**无 `req.answers`**、全局 `clarifyAnswers` 不动不清）、结果**照常入链**（链 +1，末轮 output = 新结果）、fresh 会话内澄清续跑（不带 memory、answers = freshAnswers、新答并入）、终稿后 `freshAnswers` 并入 `s.clarifyAnswers` 且已 `saveClarifyStore`、`freshRun=false`、失败/网络失败保留、取消清空、结果被丢弃清空；
5. **host 证据**（新增）：断言 `enhance-handlers.js` 中 `isContinuation` 依赖 `baseRounds.length > 0`、`memoryActive` 而无 rounds 时走单条消息分支——即「host 零改动」的合同锚；
6. **箭头动画**（新增）：`src/client/styles.js` 含 `.dsh-enh-menu-caret` 与展开态 rotate(180deg) 规则、`.dsh-plg-mselect-trigger[aria-expanded="true"] .dsh-plg-mselect-arrow`（含 params 作用域变体）、`transition:transform`、reduced-motion 关闭（按 §3.4 的**实发形态**断言：媒体块 1 次 + 块内两条 `transition:none`）；`enhance-menu.js` 触发器含 `dsh-enh-menu-caret` span 且仍带 `aria-expanded`；
7. **r2 回归（独立验证 D-1/D-2 反例，必测）**：(a) 混合态（链 `[A→O1]` + `s.enhanced=O2` + `backup=B` + result 态）⇒ 主=撤销优化、副=**⟳**（不是 ↺）；点主键 undo 回退到 **B**（不是 A），链**不 pop**、`optimized` 保持 true；(b) 模型输出以 `/deploy ` 开头且草稿未改 ⇒ 主=撤销优化 + 副=⟳（不再误判「已改」）；(c) undo 覆盖矩阵七格逐格断言草稿写入值与链变化；(d) 「重新优化」主键入口的**请求载荷**断言（`memory:false` + 预置全局澄清记录 ⇒ `sent.answers === undefined`，堵住「入口少传第 6 参」只能被 spy 抓住的薄处）；(e) 若成本允许：给 harness 的 `loadButton` 补 `clearResultStore` 桩，并补一条「result 态用户编辑草稿 → 消费为 idle + 清结果键」的 effect 分支用例（现 harness 触达即 ReferenceError）。
8. **UI 接线**：`.dsh-enh-split` 子元素 = `[aux, main, EnhanceMenu]`、`main` 仍是 button + `mainRef`、aux 类名/字形/`tabIndex:-1`、i18n `auxRedo`/`auxUndo` 成对 + `titleRedo` 新文案、空输入邻近契约仍成立。

Lead 最终验收（全量、隔离实机）：`npm run build` → `npm test` 全绿 → `npm run gate` 全绿 → 临时 `DSH_HOME` + 随机端口起隔离实例，实测双键状态机 6 态 + 箭头旋转动画（截图存档），并复核设置页另两个 tab 未受影响。

## 六、已知边缘（文档化，不额外处理）

- 刷新后连环撤销：`backup` 已丢，回退取 `memoryRounds[last].input`（**斜杠命令前缀在此边缘丢失**）；
- 专家档点 ⟳ 从零可能重新弹澄清卡（模型看不到已答记录）；澄清记录本身**不清**，下一轮「继续优化」恢复携带；
- `freshAnswers` 不持久化：fresh 会话中答题后刷新 → 该批答案作废（与「澄清卡刷新作废」一致）；
- 三键并排 `[副][主][▾]` 的宽度与观感：**已实机确认**（副键 20px 宽、紧贴主键、无重叠；截图 `shots/ui42-2-untouched.png` / `ui42-3-modified-memOn.png` / `ui42-4-modified-memOff.png` / `ui42-5-menu-open-caret-up.png`）。

## 七、实机验收记录（Lead，隔离实例）

环境：临时 `DSH_HOME`（`shots/_vis/dshhome`）+ 随机端口，插件以 symlink 装自仓库，**绝不触碰桌面 profile / 端口 3080**。

- **主键四态 + 副键字形逐态实测**：optimized+空草稿 →「继续优化(disabled) + ↺」；未改 D=L →「撤销优化 + ⟳」；已改·记忆开 →「继续优化 + ↺」；已改·记忆关 →「重新优化 + ↺」（title = 「重新优化：从零重跑（本次不带记忆上下文）」）；`.dsh-enh-split` 子元素顺序恒为 `[aux, main, menuwrap]`。
- **副键 ↺ 端到端撤销**：草稿 `优化结果文本 补充一点` → 点击副键 → 草稿 `原始草稿`（本轮起点）、主键回「✨标准」、副键隐藏。
- **箭头动画**：▾ 触发器 closed `transform:none` → 中间帧 `matrix(0.0997…,0.995…)` / `matrix(-0.735…,0.677…)` / `matrix(-0.9909…,0.134…)` → open `matrix(-1,0,0,-1,0,0)`（`aria-expanded` true、`transition:transform 0.18s`）；收起后 `none`；设置页 chip 箭头展开 `rotate(180deg)` + 列表可见、收起归零。
- **环境假象（记录备查）**：headless 无可视帧时 CSS transition 停在 `t=0`（`getAnimations()` 显示 `playState:'running', currentTime:0`）⇒ 收起后读到的仍是旋转值；强制出帧（截图 + 双 rAF）后实测归零 `none`，非代码缺陷。
- **混合态（D-1）为何没有实机截图**：刷新后组件自身 effect 会在 composer 草稿回灌之前把恢复出来的结果消费掉（`draft === s.enhanced` 不成立 → 转 idle + 清结果键，v4.1.1 起的既有竞态，非本轮引入），故该态**不可由 UI 稳定构造**；改由 chunk 级探针（独立验证 probe5：主键「撤销优化」+ 副键 `⟳`、撤销写入 B、链不 pop、刷新后一致）+ 单测 V42-34 + 矩阵 M6/M8 覆盖。
- **门禁读数**：全量 `npm test` **270/270/0**；`npm run gate` **通过 30 · 冲突 0**（RPC 注册面 24 条不变、i18n ZH/EN 216/216）；`build-host --check` / `build-client --check` 双 OK（版本 4.2.0）。
- **`optimized` + 空草稿**：机械落「已改」行 ⇒ 主键显示「继续优化」/「重新优化」且 `disabled=true`（`guardPasses('')` 为假），**不再走「空输入点击开菜单」分支**（该分支现仅首次态可达）；此时菜单仍可经右侧 ▾ 打开，副键 ↺/⟳ 照常（⟳ 受守卫不发请求）。可达性：正常清空输入框会先 `clearMemoryChain`（`optimized=false`）回首次态，故该组合仅出现在刷新首屏草稿未回灌、结果被丢弃等边缘路径——**判定为可接受**（标签与动作一致：不假装可优化），实机视觉验收覆盖此项。
- 副键图标 span 带 `aria-hidden:true`（装饰字形，语义由按钮 `title`/`aria-label` 承担）——§3.2 未列该属性，属 §3.4 口径的自然延伸，予以确认。
- reduced-motion 的**实现形式**采用「同一媒体块 + 祖先作用域选择器」（见 §3.4 冻结形态）：媒体串全文 1 次、块内两条 `transition:none`；效果等价（关闭过渡动画，方向仍瞬时翻转），**裁决通过**。
