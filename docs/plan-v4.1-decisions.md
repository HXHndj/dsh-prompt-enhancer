# v4.1 实施规范：记忆流语义修订 + 三档 skill 约束修订

> 来源：2026-09-27 用户口头决策（逐条对应 `reports/00-调研总报告.md` 的待拍板清单）。
> 本文档是并行实施的**唯一口径来源**：常量、协议字段、触发时机以本文为准；实现与本文冲突视为缺陷。
> 范围：`skills/`、`src/host/`、`src/client/`、`scripts/sync-prompts.mjs`、`test/`、`README*.md`、`docs/compatibility-matrix.md`。
> **生成物 `plugin-host.js` / `lib/client.cjs` 由 Lead 在集成阶段统一重建；实施者不得运行 build / sync-prompts（无 --check）/ npm test。**

## 0. 已定决策

| # | 决策 | 影响面 |
|---|---|---|
| D1 | 手动清空输入框后输入全新提示词 → **清链**；**切换模式 → 清链** | client |
| D2 | 刷新 → **保住链**（持久化） | client |
| D3 | 上下文预算档位改为 **8000（默认）/16000/32000** | host + client + skills + 文档 + 测试 |
| D4 | 记忆最多保留 **往前三轮**（每轮 = 优化前草稿 + 优化后结果） | host + client |
| D5 | 撤销语义**待定**，本轮不改 | — |
| D6 | 轻量档：删 1.2 倍上限、语法性补全白名单、疑问不升级；"调整结构"仅指语序/用词 | skills |
| D7 | 标准档：**任何输入都出骨架**（删简单输入门控）；800 字符硬上限改为软约束"不冗余、不凑段" | skills |
| D8 | 标准档：保留五段；补真实 `## 本轮目标` 示例并写清"何时独立成段" | skills |
| D9 | 标准档：删"禁止把疑问升级为陈述/命令"，保留"提问焦点不得丢失" | skills |
| D10 | 标准档：删"软性语气升级为明确规则" | skills |
| D11 | 明确化不再示范"补充限定词"式具体化，结构层面统一走五步法三（逻辑重组） | skills |
| D12 | 稳定条款：限定为"跨次运行确定性"，删"顺序调整"类绝对表述 | skills |
| D13 | 专家档：**不新增其他功能**（不做验收标准段、非目标段、改动摘要；现有保真自检保持原样） | skills |
| D14 | 专家档澄清卡**始终开启**（无开关）；"发现缺漏/问题→弹出选择栏"的 UI 属**下一轮** | skills + client |
| D15 | 专家档 = 标准档的增量：公共层 + 档位层拼接生成 | skills + scripts |
| D16 | 自由输入的澄清答案按规范回传优化模型，模型据此继续优化 | client + host + skills |
| D17 | 澄清问答**不占三轮名额**（独立通道） | client + host |

## 1. 钉死的常量与协议

```
BUDGET_OPTIONS    = [8000, 16000, 32000]   # host pure.js / client constants.js / skills frontmatter / i18n
DEFAULT_BUDGET    = 8000
MEMORY_ROUNDS_MAX = 3                       # 双侧一致（原 4）
配置迁移          = 旧 0/2000/4000/非法 → 8000；8000→8000；16000→16000；32000→32000
                    ★ 必须删除 v4.0.0 的 "32000→16000" 映射（32000 现为合法档位）
```

**证据正文 JSON（host → 模型，本轮 user 消息）**
```json
{"originalDraft": "<草稿原文>",
 "clarifyAnswers": [{"q": "<模型提问>", "a": "<用户答复>", "via": "option" | "custom"}],
 "skipped": true}
```
`via`：`option` = 用户点选选项；`custom` = 用户自由输入。可选字段，无答案时整字段省略。

**澄清信号 JSON（模型 → host，仅专家档）**
```json
{"clarify": true, "questions": [{"q": "...", "options": ["...", "..."], "kind": "ambiguity" | "gap"}]}
```
`kind` 本轮**只透传不渲染**（为下一轮"缺漏/歧义选择栏"留位），缺省视为 `ambiguity`。
约束不变：≤3 题、每题 2–4 选项、除该 JSON 外无其他正文。

**记忆链（client → host，RPC `enhance` 参数）**
```
req.memory  = { rounds: [{ input, output }] }   # 仅优化轮，≤3，时间序（旧→新）
req.answers = [{ q, a, via }]                   # 澄清问答，独立通道，不占 rounds
```

## 2. 记忆流生命周期（client）

1. **入链时机**：优化成功且结果被应用（保持现状）：`{input: 本轮发送的草稿正文, output: 优化结果}`。
2. **清链触发（任一命中即清链 + 删除持久化键 + 复位"继续优化"标记）**：
   - 草稿被清空：**发送成功与手动清空统一为 `draft.trim() === ''`**（D1）；
   - **切换优化模式**：设置页与 ▾ 菜单两个入口都要覆盖；只清链，不动草稿与结果态（D1）；
   - 撤销：保持现状（只回退最近一轮），本轮不改语义（D5）。
3. **持久化（刷新保链）**：新增 localStorage 键 `dsh-enh-memory:<sessionId>`，值为 `[{input,output},…]`；`storeFor()` 首次创建该会话 store 时恢复；清链时同步 `removeItem`。与既有 `dsh-enh-result:<sessionId>` 独立。
4. **轮数**：入链后 `while (length > MEMORY_ROUNDS_MAX) shift()`，上限 **3**。
5. **按钮态**：`optimized` 与链同生命周期（清链即复位）；刷新恢复时链非空即视为可继续优化。
6. **澄清问答**：不入 `memoryRounds`；随 `req.answers` 传给 host（合并历史已答，沿用 `.slice(-9)`）。
7. **零作答提交**：一题未答时不得发出"既无 answers 又无 skip"的请求（现状会原地重问）：按 `skip` 语义重跑，或禁用提交按钮（择一 + 写测试）。

## 3. 预算与注入（host）

1. **当前草稿永不截断**：最终 user 消息（证据正文 + 【本轮修改】摘要）全文注入。
2. **历史预算** `historyBudget = max(0, budgetChars - len(finalText))`；最多 3 轮。
3. **分配**：`perRoundCap = floor(historyBudget / 3)`；每轮 input 与 output **各占一半**；按**由近及远**装填，超出 `historyBudget` 时**整轮丢弃最老的**（不切碎所有轮次）。
4. **截断按行边界**：逐行累积，装不下即停，**不得**把代码块围栏 / JSON / 路径切一半。
5. **澄清问答独立通道**：预算 `min(2000, floor(budgetChars / 4))`，作为独立参考消息注入（标注"以下是澄清问答记录：模型提问 / 用户答复"），**不计入 3 轮**、不参与上述分配。
6. **消息顺序**：历史轮（早→晚，user/assistant 交替）→ 澄清问答块（可选）→ 最终 user（证据正文 + 本轮修改摘要）。
7. **健壮性必修**：`parseClarify` 不得被原始输出里**先出现的普通代码围栏**吞掉；JSON 后带含 `}` 的尾注应仍能解析；解析失败时**不得**把裸 JSON 当"终稿"返回（按 skip 降级或重试一次，择一并在报告说明）。
8. **遗留不动**：`buildMemoryChainBlock` 死代码、`estimateLiteModeSeconds` 幻影调用，本轮不处理。

## 4. 三档 skill 修订（skills/enhance/**）

结构（D15）：`_shared/base.md`（公共层：任务边界/意图判定/目标识别/五步法/骨架/明确化/保真优先/稳定性/公共示例）+ 各档增量；`sync-prompts` 生成 `SYSTEM_STANDARD_PROMPT = BASE + STANDARD_DELTA`、`SYSTEM_EXPERT_PROMPT = BASE + STANDARD_DELTA + EXPERT_DELTA`；`lite` 独立不拼接。公共层以**现行 standard 文本**为基底，只落 D9–D12 的修订。

- **lite/system.md**：删第 8 条（1.2 倍上限）、第 5 条（语法性补全白名单）、第 6 条（疑问不升级）；第 2 条保留但明确"仅表达层调整，不改语义与体裁"；替换依赖被删条款的示例（保持 3–4 组）。
- **standard**：删【简单输入门控】整节（含 800 字符上限），替换为"输出不冗余、不凑段；空段整段省略"；示例 2 改为"短疑问也出骨架"（输出含 `## 任务`）；示例 3 补 `## 本轮目标` 段 + 规则"原文出现『这轮/本次/先…』范围限定且任务较复杂时独立成段，否则并入任务句"；公共层按 D9–D12 修订。
- **expert**：保留七项盘点与阻塞级歧义判定；写明"澄清始终开启"；`questions[].kind` 透传不渲染；自由输入答案规范（`via:'custom'`，与草稿同效力、优先于选项、不得重复已答问题）；**不新增**验收/非目标/改动摘要段（D13）。
- **SKILL.md**：三档描述与 budgets（8000/16000/32000）同步；修正"新增模式=零代码改动"。

## 5. 文档与测试

- `README.md`/`README.en.md`：预算三档改 8000/16000/32000；记忆流补"切换模式 / 清空输入框 / 发送消息即清链，刷新保留，最多三轮"；标准档写明"任何输入都结构化"。
- `docs/compatibility-matrix.md`：预算与记忆表述同步。
- `test/lib.test.cjs`：预算/迁移断言（含 32000 不再降级）、`MEMORY_ROUNDS_MAX=3`、`buildChatMessages` 新口径（草稿不截断/最近优先/≤3 轮）、`parseClarify` 新容错矩阵、技能契约常量断言。
- `test/client-enhance-flow.test.cjs`：清链三触发、刷新恢复、零作答、自由输入 `via`。
- 版本号与 CHANGELOG 本轮**不动**。

## 6. 写入分工（互不重叠）

| 范围 | 归属 |
|---|---|
| `skills/**`、`scripts/sync-prompts.mjs`、`README*.md`、`docs/compatibility-matrix.md` | skills-impl |
| `src/host/**`、`test/lib.test.cjs` | host-impl |
| `src/client/**`、`test/client-enhance-flow.test.cjs`、`test/config-persist.test.cjs` | client-impl |
| `plugin-host.js`、`lib/client.cjs`、门禁、全量测试、最终验收 | Lead |

## 7. chunk 文件编辑协议（强制）

`src/**/*.js` 是"头注释 + 单行 `module.exports = "<JSON 转义代码>"`"，**禁止直接编辑**：
1. 解码副本已就绪：`.work/decoded/<路径，分隔符 __>`（`node .work/decode.mjs` 幂等重建）；
2. 编辑解码副本，`node --check .work/decoded/<文件>` 验证语法；
3. 回写：`node .work/encode.mjs <src 相对路径>`（自动保留头注释并做往返校验）；
4. 回写后重跑 `node .work/decode.mjs` 并确认内容一致。
