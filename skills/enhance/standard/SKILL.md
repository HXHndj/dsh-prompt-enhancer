---
name: enhance-standard
description: 标准模式（默认）——意图动词化（开放集合）+ 目标识别（本轮/全局，仅取原文明说的）+ markdown 分段结构化输出。无检索。
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

T1（system.md）：五步法语义重构底盘 + 意图判定（动词化融入任务句，不打标签）+ 目标识别（本轮目标 + 全局目标，仅取原文明说的，全局目标落【背景】段）+ markdown 分段骨架输出（任务/背景/本轮目标/要求/输出，按出现规则省略空段）+ 简单输入门控（短输入保持简短自然语言，不硬套结构）。
检索：无（kind=none，直发）。
