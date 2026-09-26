# 提示词增强插件 · 三方向深化调研：结构化 / 三档制 / 单轮定位

> 调研日期：2026-09-26 ｜ 本轮纯调研，未改动任何代码。
> 承接同日早些时候的全面调研 [research-prompt-enhancement.md](research-prompt-enhancement.md)，本轮只围绕三个既定方向深化：①结构化；②五模式收敛为 轻量/标准/专家 三档；③聚焦单轮提示词优化、砍掉与宿主 plan mode 重叠的部分。
> 方法：三路并行网络调研（官方文档原文、GitHub 源码 raw、GitHub API 核实星数）。关键结论附来源 URL 与原文引用，事实与推测分开标注。

---

## 〇、结论速览

**方向一（结构化）**：所有权威来源的共识是「结构化按复杂度付费」——混合多要素的长提示词收益最大，简短问答输入的官方答案就是「保持简短、最小改动、不加用户没说的东西」。最有价值的工程先例是 linshenkx/prompt-optimizer 的**模板分族**：面向聊天输入框草稿的 user-optimize 族即使最高档也要求自然语言直出、「避免过度复杂化」；完整 LangGPT 式结构只用于「系统提示词」对象。落地含义：**结构化应是「专家档」的输出形态，而非全局默认**，并配复杂度/语用门控。

**方向二（三档制）**：三档制有最强业界背书（OpenAI reasoning effort low/medium/high、Claude Haiku/Sonnet/Opus、Cursor Auto 的 Cost/Balance/Intelligence），且「中间档默认」是通行做法。linshenkx 三档（basic/planning/professional）的最大教训：**档位差异应是「策略/输出形态」的差异，而非模板长度或步骤数的强度递进**——planning 是三档中唯一强制输出结构的档位，而 professional 的步骤数（4 步）反而比 basic（5 步）少。5→3 映射：base+standard 的方法论并入「标准」，lite 降级为跨档共用的「指代消解证据」，smart/publish 的可取部件择优并入「专家」或转预置自定义模板。

**方向三（单轮定位）**：业界能查到官方文档的输入框增强器（Augment Code、Roo Code、PromptPen、linshenkx）**全部是单发、无跨提示词记忆**；没有任何一家保存「上一条提示词是怎么改的」。linshenkx iterate（只吃 lastOptimizedPrompt + 用户反馈）与 PromptPen 版本回退证明我们的「轮内记忆链」正是业界同款核心机制——保留有据。Augment 在产品文档里把 Enhancer（发送前改写）与 Agent（任务规划）写成两个独立职责，「增强不管规划」有直接产品先例。publish（一句想法→九章规格）与 plan mode 的产出物完全同构，建议整体转为预置自定义模板。

---

## 一、方向一：结构化

### 1.1 官方元提示词怎么做结构

**OpenAI prompt generation（Playground 背后的 metaprompt，[官方指南](https://developers.openai.com/api/docs/guides/prompt-generation)）**——生成的提示词遵循如下骨架，**只有第 1 行是必选的**：

1. 首行：简洁的任务描述（无节标题）【必选】
2. 按需补充细节
3. `# Steps`【可选】步骤分解
4. `# Output Format`（长度/结构/JSON vs markdown）
5. `# Examples`【可选】1–3 个示例，复杂元素用 `[方括号占位符]`（注意不是 `{{变量}}`）
6. `# Notes`【可选】边界情况与重要注意事项

配套硬规则：输出不得夹带说明文字（"no additional commentary"）；推理步骤先于结论（"Conclusion, classifications, or results should ALWAYS appear last"）；结构化任务偏好 JSON 输出但不要包代码块；用户已有的 guidelines/examples 原样保留。**edit 模式**的元提示词还要求先输出一个会被程序剥离的 `<reasoning>` 块，逐项评估 Simple Change/Structure/Examples/Complexity(1–5)/Specificity(1–5)/Prioritization，原则是「增强清晰度、补缺失项，**但不改变原结构**」（"enhance clarity and add missing elements without altering the original structure"）。

**OpenAI Cookbook 三代提示词指南的收敛轨迹**（[GPT-4.1](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide) / [GPT-5](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide) / [GPT-5.1](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide)）：
- GPT-4.1：给出 `# Role and Objective / # Instructions / # Reasoning Steps / # Output Format / # Examples / # Context` 起步骨架，明说「**Add or remove sections to suit your needs**」（按需增删节）；markdown 起步、XML 亦可、JSON 偏冗长。
- GPT-5 metaprompt：「**minimal edits/additions** … **keeping as much of the existing prompt intact as possible**」（最小改动、尽量保全原文）。
- GPT-5.1：修订规则「**Do not redesign the agent from scratch**」「Prefer small, explicit edits」「**Keep the structure and overall length roughly similar to the original**」；输出分两部分：`patch_notes`（每处关键改动+理由的清单）与 `revised_system_prompt`。← 这是「改动可追溯」的最权威现成机制。

**Anthropic**（[XML 标签指引](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/use-xml-tags)）：XML 的价值明确限定在复杂混合型提示词——"XML tags help Claude parse **complex** prompts unambiguously, especially when your prompt mixes instructions, context, examples, and variable inputs."；官方 [Metaprompt notebook](https://github.com/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb) 只强制 `<Inputs>`（最小不重叠变量集）→ `<Instructions Structure>`（先规划结构）→ `<Instructions>` 三步，且「任务特别复杂时才加思考区」。Claude 4 时代官方反而要求克制："Remove over-prompting"、"**Avoid over-engineering. Only make changes that are directly requested or clearly necessary.**"

**Google**（[Gemini prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)）："Be precise and direct"；分隔符只建议用于多部分提示词；复杂需求**拆分**而非堆结构。

### 1.2 高星项目的工程证据：按对象分族，而非一律结构化

**linshenkx/prompt-optimizer（35.8k ⭐，读自 develop 分支源码原文）**——最有价值的发现是它把模板分成两族：

| 模板族 | 对象 | 输出形态 | 关键约束原文 |
|---|---|---|---|
| `optimize/`（general、analytical 等） | 系统提示词 | **完整 LangGPT 式结构**：Role/Profile/Skills/Rules/Workflows/Initialization | 「不要携带任何引导词或解释，不要使用代码块包围」；`{{变量}}` 逐字保留 |
| `user-optimize/`（basic、planning、professional） | 聊天输入框用户草稿 | **自然语言直出**（basic/professional 无固定结构） | 「保持用户的原始意图和核心需求不变」「**避免过度复杂化，保持简洁实用**」「**不添加用户未提及的新需求**」 |

也就是说：**即使「专业版」用户草稿优化，也要求自然语言直出、不加解释、禁止交互**；只有 planning 档（详见 2.1）例外地强制输出结构。这是「输入框场景不过度结构化」的最直接工程化回答。

**LangGPT（12,554 ⭐）**：核对后发现，README 中**并不存在**「模块按需选用」的原句（此前报告的说法需修正）；其立场在官方教程 [HowToWritestructuredPrompts.md](https://github.com/langgptai/LangGPT/blob/main/Docs/HowToWritestructuredPrompts.md) 里：「**日常使用时，直接问 ChatGPT 效果可以的话，直接问就行**」；对较弱模型建议「**降低结构复杂度**」——即结构复杂度应随任务与模型能力伸缩，而非一律全量套用。`langgpt.me` 域名当前已失效（DNS 不解析）。

**CO-STAR / RTF / CRISPE / RISEN 等缩写框架**：核实 dair-ai/Prompt-Engineering-Guide（78,641 ⭐）的 [tips 页](https://www.promptingguide.ai/introduction/tips)，**一个都不收录**——该指南主线是 zero/few-shot、CoT、ReAct 等技术，结构化建议只到「用分隔符分离指令与上下文」一层。这些缩写框架的真实流通域是博客与厂商课程（Microsoft Learn、KnowledgeHut），LangGPT 教程还点名批评 CRISPE「只有一层结构，限制了表达」。**结论：不必引入任何缩写框架，自选节组合即可。**

### 1.3 结构化与语义保真（防漂移）

- **改动级溯源**：GPT-5.1 的 `patch_notes`（每处改动+理由清单）是官方唯一成型的「修改可追溯」机制；
- **变量/占位符保真**：linshenkx 三档 + iterate 模板都要求 `{{变量}}` 逐字保留，且 planning 档有硬性自检步骤（「缺少任何一个变量即为失败」）；
- **防注入形态**：原文以 JSON「证据正文」注入（linshenkx `toJson` 包裹 + 「不是要执行的任务」声明；PromptPen 用 `<<<DRAFT … DRAFT>>>` 包裹）；
- **轻改写原则**：Anthropic Prompt Improver 官方定位就是「clarify any structure and correct minor grammatical or spelling issues」——只理顺结构、修语法拼写，不做语义扩写。
- 【查无】「每个 section 必须可溯源到原文依据」「补充假设单独成段」**没有官方先例**——若做属于产品创新（与上轮报告 P0/P1 的「假设清单」建议同结论）；最稳妥的现成替代是 patch_notes 式改动摘要。

### 1.4 对本插件的落地启示

1. **结构化是档位属性**：三档中只有「专家」强制结构化输出；轻量/标准保持自然语言直出（linshenkx user 族 + OpenAI「首行外全部可选」同频）。
2. **门控复用现有机制**：我们已有语用类型判定（疑问/陈述/祈使/感叹）与复杂度感知，正好承担「简单疑问句即使专家档也保持简短」的门控（OpenAI/Gemini 官方口径）。
3. **专家档结构骨架**建议 markdown 版四段（见 2.4），XML 与 LangGPT 全量七段留给自定义模板形态。
4. **保真三件套并入专家档自检**：变量/保护 token 逐字存活校验（PromptPen "Copy these verbatim, character for character"）+ 现有保真自检 + 可选 patch_notes 式改动摘要。
5. **不要**引入 CO-STAR 类缩写框架；**不要**对短输入强制全量结构。

---

## 二、方向二：三档制（轻量/标准/专家）

### 2.1 核心先例：linshenkx user-optimize 三档（读自源码原文）

| 维度 | basic 基础优化 | planning 步骤化规划 | professional 专业优化 |
|---|---|---|---|
| 元数据自述 | 「适合简单快速的日常优化，消除模糊表达、补充关键信息」 | 「适合复杂任务场景，将模糊需求分解为具体执行步骤」 | 「适合需要精准描述的场景，将泛泛而谈转为具体要求，添加量化标准和明确参数」 |
| 角色定位 | 用户提示词基础优化助手 | 用户需求步骤化规划专家 | 用户提示词精准描述专家 |
| **策略本质** | **清晰化**：消歧、补基础信息、保持简短 | **形态转换**：一句话需求 → 完整规划型 prompt | **参数化**：抽象词 → 可量化参数 |
| 工作流步骤 | 5 步 | 5 步 | **4 步**（最少） |
| 输出结构 | 无固定结构，自然语言直出 | **唯一强制结构档**：「输出格式：Markdown」，必须严格遵循 `# 任务 / ## 1. 角色与目标 / ## 2. 背景与上下文 / ## 3. 关键步骤 / ## 4. 输出要求`，不得省略或添加 | 无固定结构，自然语言直出 |
| 信息缺口处理 | 只补基础信息，「不要主观添加过多细节」 | 模型自行补背景，**允许写「无」** | 明确禁止交互：「不要与用户进行交互或询问更多信息」 |
| 模板体积 | 3,516 B | 6,149 B（最大） | 3,762 B |

**三条关键洞察**：
1. **三档是三种正交策略，不是同一流程的浅/中/深**——basic=清晰化、planning=规划型形态转换、professional=参数化具体；模板体积与步骤数都不随档位单调递增。
2. **「档位升级」体现在输出形态变化**（只有 planning 改变输出结构），而不是字数变多。
3. **三档共同纪律**：重写而非执行、`{{变量}}` 逐字保留、一律不向用户追问（缺口由模型补全并允许标「无」）——与聊天输入框单次调用场景契合。

### 2.2 三档制的产品先例与命名

| 先例 | 档位 | 默认 | 出处 |
|---|---|---|---|
| OpenAI reasoning effort | low / **medium** / high（后扩展 minimal…max 多值） | 「medium：a well-balanced point on the pareto curve of latency, performance and cost；**Default configuration for most workloads**」 | [官方文档](https://developers.openai.com/api/docs/guides/reasoning) |
| Claude 模型家族 | Haiku（快）/ Sonnet（平衡）/ Opus（最强）——「three state-of-the-art models **in ascending order of capability**…select the optimal balance of intelligence, speed, and cost」 | 中档为常用默认 | [官方公告](https://www.anthropic.com/news/claude-3-family) |
| Cursor Auto 模式 | **Cost / Balance / Intelligence** 三档偏好，Router 按请求自动选模型 | Auto 为默认、可随时手动钉死 | [官方文档](https://cursor.com/docs/models) |
| ChatGPT 模型选择器 | Instant / Thinking / Pro（+Auto） | Standard | [Model Release Notes](https://help.openai.com/en/articles/9624314-model-release-notes) |

命名规律：能力轴（Haiku/Sonnet/Opus、mini/标准）、速度轴（Instant/Fast/Thinking）、成本轴（Cost/Balance/Intelligence）；三档几乎总是「快—平衡—强」结构，**中间档默认**。中文语境下「轻量/标准/专家」完全符合该惯例。

**反面与演化教训**：
- **Gemini AI Studio "Enhance prompt" 是零档位单按钮**，且官方无任何文档——零档位也是合法设计（面向新手免决策），但与我们「用户可调」的定位不符；
- **PromptPerfect 用连续参数**（`iterations` 数值而非档位）且服务已于 2026-09-01 关停（**修正上轮报告将其列为参照的表述**）——连续参数对普通用户不友好；
- **Claude Code 的 think/megathink/ultrathink 魔法词档位已被官方文档移除**，只剩 `Option+T` 二元开关；API 侧 budget_tokens 弃用、转向离散 effort 档（默认 high）——「关键词触发档位」的 UX 被淘汰了，档位应是显式 UI 选择；
- **OpenAI 曾回收 Instant→Thinking 自动切换**（社区抱怨）；GitHub Copilot 的 auto model selection 则把「实际选了哪个模型」做成 hover 可查——**若未来做自动选档，必须可被发现**。

### 2.3 五模式 → 三档映射建议

| 现模式 | 内容 | 去向建议 |
|---|---|---|
| base | 通用语义重构（T1 重述 / T2 保守增量），无检索 | 方法论主体并入「标准」；T2 保守基因并入「轻量」 |
| lite | 延续上一轮任务背景（上一轮会话参考） | **不再是独立档**：降级为三档共用的「指代消解证据」（最近 N 轮，能确定才消解；详见 4.4） |
| standard | 会话近/中/远三档窗口 + 多轮演进增量 | 五步法并入「标准」；重会话窗口砍掉（与 plan mode 重叠），只留指代消解级轻证据 |
| smart | 开发意向判定 + 工作区三门槛检索 + 【调整方案】自评尾段 | 默认档中下线；「自评修订」可并入「专家」自检；工作区检索去留见 4.4 讨论点 |
| publish | 一句想法 → 九章开发规格（websearch 规划 + 逐章生成） | **从默认档整体移除，转为预置自定义模板**（与 plan mode 产出物同构；现有自定义模板架构零改动可承载） |
| 轮内记忆链（rounds ≤4）+ 继续优化 + 撤回 | 单个提示词的优化→修改→再优化 | **保留**——业界同款核心机制（见 4.1/4.3） |

配套建议：
- **T1/T2 双模板轴由档位轴吸收**（轻量=保守增量基因，标准/专家=重述梳理基因），避免 3 档 × 2 模板 = 6 组合的认知负担（讨论点 #1）；
- 检索判定子技能随之精简：websearch/doc-analysis 随 publish/smart 下线；relevance 降级为指代消解服务；intent（isDevIntent）不再承担模式路由；
- 上下文预算表（budgets 六档）保留 roundsChars（服务轮内记忆链），smart 系列预算列随检索下线简化。

### 2.4 三档 × 关键维度设计矩阵（综合 linshenkx + OpenAI 先例）

| 维度 | 轻量 | **标准（默认）** | 专家 |
|---|---|---|---|
| 对标 | linshenkx basic | basic ↔ planning 之间的平衡档 | planning + professional 合并 |
| 策略 | 清晰化：消歧、纠错、顺句 | 平衡改写：五步法、适度补全 | 结构化 + 参数化 |
| 输出形态 | 自然语言直出，长度与原文相当 | 自然语言；长/复杂草稿按需轻度分段 | 固定骨架：`# 任务 / ## 角色与目标 / ## 背景与上下文 / ## 关键步骤 / ## 输出要求`；简单疑问句仍降级保持简短（门控） |
| 补全边界 | 只补最基础的缺失信息 | 补目标/受众/格式等明显缺口，可溯源 | 补量化标准/验收要求；缺口允许标「无」，禁止虚构 |
| 自检 | 全局纪律层 | 现有保真自检 | 保真自检 + 变量/保护 token 存活校验 + 可选改动摘要（patch_notes 式，折叠 UI 展示） |
| 会话证据 | 无或仅指代消解 | 指代消解（能确定才消解） | 同标准 |
| 交互 | 不追问 | 不追问 | 不追问（业界三档一致） |
| 成本 | 最短模板、最快 | 中 | 最长模板（结构规范+自检清单），仍单次调用 |

---

## 三、方向三：单轮定位（约束行为）

### 3.1 业界输入框增强器全是「单发、无跨提示词记忆」

| 工具 | 形态 | 证据 |
|---|---|---|
| **Augment Code Prompt Enhancer** | ✨ 按钮单次改写，改完用户审阅再发送；文档明说增强器只做 "improve the prompt before it is sent"，而任务规划 "breaks down your requests into a functional plan" 是 **Agent 本体的职责**——**增强与规划在产品内是两个独立段落** | [官方文档](https://docs.augmentcode.com/using-augment/agent) |
| **Roo Code Enhance Prompt** | 输入框 ✨ 单次改写（早期仅 OpenRouter，后放开 provider） | changelog + 多源 |
| **PromptPen** | 单次改写 + 单条草稿的版本回退；无跨条记忆 | README 与 `src/enhance/prompts.ts` 源码 |
| **linshenkx/prompt-optimizer** | 单次优化 + iterate 版本链；无跨提示词/项目级记忆（preference service 只存主题/语言等应用设置） | `default-templates/iterate/iterate.ts` + `services/prompt/service.ts` 源码 |
| **Cline** | 刻意不做：官方回复 "We've tested 'enhance prompt' but haven't seen clear performance benefits." | [r/CLine](https://www.reddit.com/r/CLine/comments/1mmjtyv/i_wish_cline_had_an_enhance_prompt_button_like) |

**生态位旁证**：VS Code 官方 2025-09 的 "Add chat enhance action" PR 被作者自行放弃未合并，"improve a prompt" 的 issue 至今在 Backlog（[PR #267113](https://github.com/microsoft/vscode/pull/267113)、[Issue #278111](https://github.com/microsoft/vscode/issues/278111)）；Cursor 官方文档无 Enhance 按钮、论坛多条请求帖——**宿主普遍没做、社区在要**，单发轻量增强正是空档生态位。Cline 的反面案例同时提醒：增强收益必须可感知（改写质量/保护 token 不改坏）。

### 3.2 与 plan mode 的分界：上下游而非竞争

- Claude Code plan mode："Claude reads files, runs shell commands to explore, and writes a plan, but does not edit your source"（[permission-modes](https://code.claude.com/docs/en/permission-modes)）；
- Cursor Plan Mode："Agent researches your codebase, asks clarifying questions, and generates a reviewable plan"（[plan-mode](https://cursor.com/docs/agent/plan-mode)）；
- VS Code Plan agent："researches your project, asks clarifying questions, and creates a plan for you to review"（[planning](https://code.visualstudio.com/docs/agents/run/planning)）。

三家 plan mode 的输入**恰恰是一句已经写得清楚的提示词**：plan mode 负责「读仓库→澄清→分解目标→计划→审批→执行」这条重流程；输入框增强器负责这句话成形之前「把话说明白」。Augment 已把这条分界写成产品事实。可借鉴 SQLite 式定位声明：「本插件不和 plan mode 竞争，它竞争的是你按下发送键前那十秒钟的措辞。」

### 3.3 记忆该记什么：业界分层证据

- **ChatGPT**（[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)）：Custom Instructions（显式偏好）vs Memory（自动记住的偏好/事实）vs 会话上下文，三层职责分明；官方示例全部是偏好类（"Remember that I am vegetarian…"），无一例任务执行细节。
- **Claude Code**（[memory 文档](https://code.claude.com/docs/en/memory)）官方「不该进记忆」清单：**可从代码库推导的内容**（架构/路径/依赖）与**多步骤流程**不进记忆，应交给 skill/plan mode；适合记的是 build/test 命令、编码规范、命名约定等偏好事实。
- **linshenkx iterate**：输入只有 `lastOptimizedPrompt + iterateInput`（JSON 证据包裹），不回看更早版本、不涉及其他提示词——**与我们「轮内记忆链」完全同构**；PromptPen 的 ←/→ 版本回退同理。

**砍留结论表**（对照现有能力）：

| 现有能力 | 业界对照 | 建议 |
|---|---|---|
| 轮内记忆链（优化→修改→再优化，rounds ≤4） | linshenkx iterate / PromptPen 版本回退 | **保留**（核心同款机制） |
| 继续优化 / 撤回 | iterate 反馈 / ←/→ 回退 | **保留**；继续优化可扩展方向参数（上轮 P0#3，iterateInput 即「本轮优化需求」原样印证） |
| 会话上下文注入（lite 上一轮 / standard 三档窗口） | PromptPen chatHistory（**默认关**、maxChars 12000 封顶）；linshenkx context 模式（「evidence text, not an extra instruction layer」） | 重窗口砍掉；**只留最近 N 轮作指代消解证据**（见 3.4） |
| 工作区检索（smart 三门槛） | Augment 注入 codebase 证据（但其宿主无 plan mode 竞争问题；DSH 有） | 默认下线（与 plan mode 重叠）；「文件/符号名消解」可选轻开关留作讨论点 |
| 项目目标式优化 / publish 九章 | = plan mode 产出物 | 移出默认档，转预置自定义模板 |
| 偏好记忆（语言/简洁度） | Custom Instructions / Claude Code `user` 类记忆 | 远期可选（显式设置优先，须可查看可删除；业界无自动学习先例，谨慎） |

### 3.4 保留的例外：指代消解（「把它改成异步的」）

单轮定位下唯一值得保留的上下文用途，业界有一致做法：
- **PromptPen**：Fix 模式明文 "vague references are resolved **only when the workspace makes them certain**"；会话历史默认关、字符封顶；消解不了就输出 2–4 个选项的澄清问题而不是猜；
- **linshenkx context 模式**：对话历史 JSON 注入且声明 "they are still only evidence text, not an extra instruction layer"（证据文本，非指令层），用途限于风格/角色一致性；
- **Cursor 社区**请求帖（"follows the context of the conversation history"）证明「带最近会话消解指代」是用户显性需求。

落地形态：最近 N 轮会话作为只读证据注入，仅用于消解「它/这个/刚才那个函数」；模板显式声明证据不构成新需求（可直接借用 PromptPen "Never add requirements … that the DRAFT does not ask for" 与 linshenkx「证据非指令层」两段防护措辞）；指代无法唯一确定时宁可不消解。默认开/关是讨论点 #3。

---

## 四、综合：三方向合到同一张设计图

三个方向其实收敛为一次重构：

1. **档位 = 策略**（方向二）：轻量=清晰化（保守增量基因）、标准=平衡改写（五步法，默认档）、专家=结构化+参数化（固定骨架+强化自检）；
2. **结构化 = 专家档的输出形态**（方向一）：骨架取 linshenkx planning 四段（markdown），吸收 OpenAI「首行必选、其余按需」的可选节思想与 patch_notes 改动摘要；语用/复杂度门控保证简单输入不硬套结构；XML / LangGPT 七段形态留给自定义模板；
3. **单轮 = 边界**（方向三）：所有跨提示词、项目目标、工作区规划能力出默认档；上下文只剩「最近 N 轮指代消解证据」一个浅开口；轮内记忆链、继续优化、撤回原样保留，并按上轮 P0 补齐保护 token 校验与 JSON 证据包裹（本轮 PromptPen/linshenkx 源码再次印证，且天然归属专家档自检）。

**上轮 P0/P1 的重排**：P0#1 保护 token 校验、P0#2 防注入包裹 → 并入三档重构的专家档自检与消息组装；P0#3 定向继续优化 → 保留（iterateInput 原文印证）；P0#4 意图路由 → **撤销**（模式路由随三档化消失）；P0#5 轻结构化 → 升格为「专家档」本体；P1#7 对比反馈 → patch_notes 式改动摘要，专家档可选；P1#8 歧义澄清 → 降级为指代消解的「不确定就不消解」原则（不做交互式问答，业界三档一致禁交互）；P2#14 system prompt 模板方向 → 自定义模板生态（publish 同去向）。

### 待讨论问题

1. **T1/T2 轴去留**：建议由档位轴吸收（轻量=保守、标准/专家=重述），避免 3×2 组合；是否接受？
2. **专家档骨架**：markdown 四段（任务/角色与目标/背景与上下文/关键步骤/输出要求）+ 可选节（示例/注意事项）是否认可？还是想保留 LangGPT 七段作为专家档形态？
3. **指代消解证据默认值**：PromptPen 默认关；建议「最近 N 轮 + 能确定才消解 + 字符封顶」，默认取关还是浅开？
4. **smart 遗产**：「文件/符号名消解」要不要留一个可选开关（对标 Augment），还是彻底下线？
5. **改动摘要**：patch_notes 式「改了什么、为什么」放专家档可选输出 + 折叠 UI——做不做？
6. **publish/smart 的模板资产**：是否预置为自定义模板目录里的出厂模板（用户可一键用回），还是彻底删除？

---

## 附：对上轮报告的事实修正

- PromptPerfect 已于 2026-09-01 关停，不再适合作为参照；
- Anthropic Console 的 Prompt Improver 独立文档页已 404/重定向，社区报告 Console 内 Improve 入口疑似移除（[社区帖](https://www.reddit.com/r/ClaudeAI/comments/1m0ohmn/does_anthropics_prompt_improver_still_exist)，状态未确认）；其「五步机制」描述仍有效（官方博客在）；
- LangGPT「模块按需选用」在 README 中无原句（立场在教程：简单场景直接问、弱模型降结构复杂度）；`langgpt.me` 域名失效；
- Claude Code 的 think/ultrathink 魔法词已从官方文档移除（`Option+T` 二元开关替代）；API 侧 budget_tokens 弃用、转向 effort 档位。

## 附：核心来源

- OpenAI：[prompt-generation](https://developers.openai.com/api/docs/guides/prompt-generation)、[GPT-4.1 指南](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)、[GPT-5 指南](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)、[GPT-5.1 指南](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide)、[reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)
- Anthropic：[XML 标签](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/use-xml-tags)、[Metaprompt notebook](https://github.com/anthropics/claude-cookbooks/blob/main/misc/metaprompt.ipynb)、[prompt-improver 博客](https://claude.com/blog/prompt-improver)、[Claude Code memory](https://code.claude.com/docs/en/memory)、[permission-modes](https://code.claude.com/docs/en/permission-modes)、[extended thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)
- linshenkx/prompt-optimizer（35.8k ⭐，develop 分支源码）：`default-templates/user-optimize/`（basic/planning/professional）、`default-templates/iterate/iterate.ts`、`services/prompt/service.ts`、`docs/user/context-mode.md`
- LangGPT（12,554 ⭐）：[README_zh](https://github.com/langgptai/LangGPT)、[HowToWritestructuredPrompts.md](https://github.com/langgptai/LangGPT/blob/main/Docs/HowToWritestructuredPrompts.md)
- PromptPen：[仓库](https://github.com/Metonya/promptpen)（README + `src/enhance/prompts.ts`）
- 输入框增强生态：[Augment](https://docs.augmentcode.com/using-augment/agent)、[VS Code PR #267113](https://github.com/microsoft/vscode/pull/267113)、[Issue #278111](https://github.com/microsoft/vscode/issues/278111)、[Cursor prompting](https://cursor.com/docs/agent/prompting.md)、[Cursor plan-mode](https://cursor.com/docs/agent/plan-mode)、[VS Code planning](https://code.visualstudio.com/docs/agents/run/planning)、[Copilot auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection)、[Cursor models](https://cursor.com/docs/models)
- 其他：[dair-ai/Prompt-Engineering-Guide（78,641 ⭐）tips 页](https://www.promptingguide.ai/introduction/tips)、[Gemini prompting strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies)、[SQLite 边界声明](https://www.sqlite.org/whentouse.html)、[Claude 记忆博客](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it)
