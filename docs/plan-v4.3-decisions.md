# v4.3 实施规范：询问工具（澄清卡）= 缺漏/歧义**唯一准入口**

> 用户决策（2026-09-27）：优化模型发现**语义模糊 / 缺漏 / 歧义**时，只能通过 `questions[].kind` 协议向用户提问；可提**一个或多个**问题；问题内容、选项、类型由模型判断生成；「跳过直接优化」按**保守策略**＝保留用户原语句。

## 1. 协议（模型 → host，仅专家档，除 JSON 外无其他正文）

```json
{"clarify": true, "questions": [
  {"kind": "gap", "q": "这个函数具体指哪一个？"},
  {"kind": "gap", "q": "期望的输出格式？", "options": ["Markdown", "纯文本"]},
  {"kind": "ambiguity", "q": "「它」指哪个函数？", "options": ["parseConfig", "loadPlugins"]}
]}
```
- 题数 **1–3**（>3 截断为前 3；空数组/无有效题 → 非澄清）。
- `kind` 缺省 = `ambiguity`。
- `kind='gap'`（**补信息**）：`options` 可省略或空数组（0 个）→ 用户自由输入；也可给 0–4 个建议选项供点选。
- `kind='ambiguity'`（**消歧**）：`options` 必须 2–4 个（不足则该题丢弃，沿用现有口径）。
- `q` 非空、截断 200 字符（现有）。

## 2. 答案协议（client → host）

```
req.answers = [{ q, a, via }]   via ∈ { "option", "custom", "keep" }
req.skip    = true              # 全局「跳过直接优化」= 保守：全部保留原句
```
- `option`：点选某选项，`a` = 选项文本；`custom`：自由输入，`a` = 原样文本；
- `keep`（**新增**）：该题选择「保留原句」，`a = ""`；
- 点「跳过直接优化」时：client 发 `skip:true` **且** 对全部题各发一条 `{q, a:"", via:"keep"}`（供记忆链去重，避免下一轮重复追问）。

## 3. 模板语义（expert 增量 + continue.md）

- 模型**只能**用该 JSON 提问（唯一准入口）——不得在正文里反问用户、不得输出终稿与 JSON 混排。
- gap = 原文缺失必要信息；ambiguity = 原文有多种理解；**kind 只作分类**，不改变 JSON 结构。
- 收到 `via:"keep"` 的题：该点**保持原文原样**（不替用户选边、不擅自挑选选项），且**不得再次提问**；
- 收到 `skipped:true`（全局跳过）：所有歧义/缺漏点保持原文原样；随附的 keep 条目同样不得再问；
- 答案（含 keep）与草稿同效力，写入记忆链（继续优化不重复问）。

## 4. 实现改动点

**host（src/host/pure.js / enhance-handlers.js）**
1. `parseClarify`：`kind='gap'` 允许 0 个 options（当前 `options.length < 2 → continue` 会整题丢弃）；`ambiguity` 维持 ≥2；kind 透传不变。
2. `enhance-handlers` 的 answers 归一化：`via` 白名单加 `'keep'`；`a` 允许空串（过滤条件已允许 q 非空即可，勿再加 a 非空限制）。
3. `buildClarifyMessage`：keep 条目渲染为「用户答复：（保留原句，不作答）」，让模型在参考消息里看得见。
4. 记忆链/证据正文：keep 条目照常写入（`a:""`）。

**client（src/client/**）**
1. `helpers.enhance` 的 `roundAnswers` 过滤：**保留 via='keep' 且 a 为空**的条目（当前 `x.a.trim() !== ''` 会把它们丢掉）；`skip` 与 `answers` 可同时发送（现在二者是 else-if 互斥，需改为可并存）。
2. `ClarifyPanel` 按 kind 渲染：
   - `gap`：文本/questions 说明 + `保留原句` 选择行（radio 形态，选中 → `{a:'', via:'keep'}`）+ 自由输入 textarea（输入 → `{a, via:'custom'}`）；
   - `ambiguity`：选项行（2–4）+ 自由输入（现状不变）；
   - 每题可显示极轻的 kind 提示（如 12px tertiary「补充信息 / 澄清歧义」），不影响几何。
3. 提交可用条件：**至少一题已作答或已选保留原句**；全部未作答且未选保留 → 仍禁用提交（沿用零作答防护）。
4. 「跳过直接优化」：发 `skip:true` + 全部题的 keep 条目。
5. i18n：新增 `clarifyKeep`（保留原句）、`clarifyKindGap`（补充信息）、`clarifyKindAmbiguity`（澄清歧义），ZH/EN 成对；`submit` 收集时 keep 条目 `a:''`。

**测试**：host `test/lib.test.cjs`（gap 0 选项通过 / gap 带选项 / ambiguity 1 选项仍丢弃 / 混合 kind / >3 截断 / keep 透传与 buildClarifyMessage 渲染）；client `test/client-enhance-flow.test.cjs`（gap 题渲染 + 保留原句 → via:'keep' + 提交可用；skip 同时携带 answers；keep 不被过滤；零作答仍禁用）。

## 5. 写域与验收

| 范围 | 归属 |
|---|---|
| `skills/enhance/expert/system.md`、`skills/enhance/assemble/continue.md`、`scripts/sync-prompts.mjs` 生成区、`src/host/**`、`test/lib.test.cjs` | host-impl |
| `src/client/**`、`test/client-enhance-flow.test.cjs` | client-impl |
| 构建/门禁/全量测试/临时实例视觉核验/报告 | Lead |

验收：`sync-prompts --check`、`build-* --check`、`npm run gate`、`npm test` 全绿；**真实渲染**核验：gap 题（输入 + 保留原句）与 ambiguity 题（选项 + 输入）同卡共存，提交/跳过两条路径正确。
