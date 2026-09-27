---
name: enhance-expert
description: 专家模式——标准档全部能力（公共层 + 标准档增量）+ 七项要素盘点（已明确/缺失/歧义）+ 阻塞级歧义澄清（澄清始终开启；≤3 题固定 JSON 澄清信号，可跳过；kind 仅透传不渲染）。无检索。
mode: expert
templates:
  t1: system.md
retrieve:
  kind: none
  windows: []
sources: []
rules: []
---

# 专家模式（expert）

T1（system.md·档位增量）：注入给模型的专家档提示词 = 公共层 `_shared/base.md` + 标准档增量 + 本增量，由 `scripts/sync-prompts.mjs` 拼接为 `SYSTEM_EXPERT_PROMPT`（`EXPERT_DELTA_PROMPT`），即「标准档全部内容 + 专家条款」。
增量内容：① 档位定位——**澄清始终开启**（无开关）；② 七项要素盘点对照清单（对象与范围/受众或执行者/输出格式/技术栈或语言/边界与非目标/验收方式/依赖与上下文，逐项判定「已明确/缺失/歧义」）；③ 阻塞级歧义判定（仅实质改变结果才澄清）；④ 输出双协议——协议 A 终稿＝公共层 markdown 骨架；协议 B 澄清信号＝固定 JSON：≤3 题、每题 2–4 选项、每题可带 `kind`（ambiguity|gap，缺省 ambiguity，**只透传不渲染**）、除该 JSON 外无其他正文；可跳过，跳过＝歧义点保持原文开放性；⑤ 澄清答复处理——`clarifyAnswers`（`{q,a,via}`）与草稿同效力、不得重复已答问题，`via:"custom"`（自由输入）优先于同题选项。
**不新增**验收标准段 / 非目标段 / 改动摘要（D13）；保真自检沿用公共层五步法五。
检索：无（kind=none，直发）。