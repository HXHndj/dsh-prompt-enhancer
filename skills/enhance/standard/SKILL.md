---
name: enhance-standard
description: 标准模式（默认）——公共层之上的档位增量：任何输入都出骨架（含短疑问）、输出不冗余不凑段；配合公共层给出意图动词化 + 目标识别 + markdown 五段结构化输出。无检索。
mode: standard
templates:
  t1: system.md
retrieve:
  kind: none
  windows: []
sources: []
rules: []
---

# 标准模式（standard，默认）

T1（system.md·档位增量）：注入给模型的标准档提示词 = 公共层 `_shared/base.md` + 本增量，由 `scripts/sync-prompts.mjs` 拼接为 `SYSTEM_STANDARD_PROMPT`（`STANDARD_DELTA_PROMPT`）。
增量内容：① 档位定位——**任何输入都出骨架**（简单输入门控与 800 字符上限已删：短疑问也先给 `## 任务`），输出不冗余、不凑段、空段整段省略、不复述原话充数；② 档位示例——短疑问也出骨架（示例 3）＋ 本轮目标独立成段（示例 4：原文出现「这轮/本次/先…」范围限定且任务较复杂时独立成段，否则并入任务句）。
公共层承载：任务边界 / 意图判定 / 目标识别 / 五步法 / 五段骨架与出现规则 / 明确化原则 / 保真优先 / 稳定性 / 公共示例。
检索：无（kind=none，直发）。