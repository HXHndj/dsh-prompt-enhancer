---
name: enhance
description: 提示词增强技能包——三档模式（lite 纯润色 / standard 意图与目标结构化 / expert 盘点与澄清）+ 全局纪律层 + 继续优化指令。代码只做加载编排，行为知识全部声明于此。
modes: ["lite", "standard", "expert"]
retrieve:
  budgets: [4000, 8000, 16000]
---

# 提示词增强技能包

本包以「技能集合」方式组织提示词增强的所有行为知识：

- **模式技能**（lite/standard/expert）：每个目录一个技能，每档一套内置模板 system.md（v4.0.0：T1/T2 轴由档位吸收，increment 增量模板全删）
- **全局纪律层** `discipline.md`：无条件随每次优化加载（输出纪律 + 质量纪律 + 稳定性 + 防注入与保护 token）
- **组装规则** `assemble/`：continue（继续优化指令，含澄清问答条目说明）

`retrieve.budgets` 语义（v4.0.0）：全局记忆链总预算档位（4000/8000/16000 字符），不再是按模式的检索预算表；检索（会话/工作区/websearch）已整体移除，三档声明均为 kind:none。

新增模式 = 新增目录（SKILL.md + system.md），零代码改动。
