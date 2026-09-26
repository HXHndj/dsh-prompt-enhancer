---
name: enhance-expert
description: 专家模式——标准档全部能力 + 七项要素盘点（已明确/缺失/歧义）+ 阻塞级歧义澄清（≤3 题固定 JSON 澄清信号，可跳过）。无检索。
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

T1（system.md）：标准档全部内容 + 要素盘点（对照清单：对象与范围/受众或执行者/输出格式/技术栈或语言/边界与非目标/验收方式/依赖与上下文，逐项判定「已明确/缺失/歧义」）+ 阻塞级歧义判定 + 输出双协议（终稿＝标准档 markdown 骨架；阻塞级歧义 → 固定 JSON 澄清信号：≤3 题、每题 2–4 个选项、不含其他正文；可跳过，跳过＝歧义点保持原文开放性）。
检索：无（kind=none，直发）。
