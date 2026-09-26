---
name: enhance-lite
description: 轻量模式——纯润色：梳理语序、精化用词、纠正错别字；零增量（不添加未提及内容、不删要点），输出 ≤ 原文 1.2 倍。无检索。
mode: lite
templates:
  t1: system.md
retrieve:
  kind: none
  windows: []
sources: []
rules: []
---

# 轻量模式（lite）

T1（system.md）：纯润色——只改写表达本身（语序、用词、错别字与标点），零增量红线：不添加用户未提及的内容、不删原文要点；自然语言直出，长度 ≤ 原文 1.2 倍；疑问语气不升级为命令（语用锚点继承）。
检索：无（kind=none，直发）。
