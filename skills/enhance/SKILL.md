---
name: enhance
description: 提示词增强技能包——公共层 + 三档模式（lite 纯润色 / standard 意图与目标结构化（任何输入都出骨架） / expert 盘点与澄清（澄清始终开启，记忆流固定开启不受开关控制））+ 全局纪律层 + 继续优化指令。代码只做加载编排，行为知识全部声明于此。
modes: ["lite", "standard", "expert"]
retrieve:
  budgets: [8000, 16000, 32000]
---

# 提示词增强技能包

本包以「技能集合」方式组织提示词增强的所有行为知识：

- **公共层** `_shared/base.md`（v4.1·D15）：任务边界 / 意图判定 / 目标识别 / 五步法 / 输出骨架 / 明确化原则 / 保真优先 / 稳定性 / 公共示例——**只作拼接部件**，绝不单独注入给模型。
- **模式技能**（lite/standard/expert）：每档一个目录。`standard/system.md` 与 `expert/system.md` 只写**档位增量**，由 `scripts/sync-prompts.mjs` 拼接生成注入常量：
  - `SYSTEM_LITE_PROMPT` = `lite/system.md`（独立档，不拼接）
  - `SYSTEM_STANDARD_PROMPT` = `BASE_PROMPT` + `STANDARD_DELTA_PROMPT`
  - `SYSTEM_EXPERT_PROMPT` = `BASE_PROMPT` + `STANDARD_DELTA_PROMPT` + `EXPERT_DELTA_PROMPT`
- **全局纪律层** `discipline.md`：无条件随每次优化加载（输出纪律 + 质量纪律 + 稳定性 + 防注入与保护 token）
- **组装规则** `assemble/`：continue（继续优化指令，含澄清问答条目说明）

`retrieve.budgets` 语义（v4.0.0 起，v4.1 改档）：全局记忆链总预算档位（8000/16000/32000 字符，默认 8000），不再是按模式的检索预算表；检索（会话/工作区/websearch）已整体移除，三档声明均为 kind:none。

**新增模式不是零代码改动**，须四处同步：① 新增目录（`SKILL.md` + `system.md`）；② `scripts/sync-prompts.mjs` 的 `NAME_MAP`（未登记即抛错）；③ host 档位白名单 `src/host/pure.js` 的 `MODE_TABLE`/`MODE_KEYS`；④ client 档位常量 `src/client/constants.js` 的 `MODE_OPTIONS`（含 i18n 标签）。