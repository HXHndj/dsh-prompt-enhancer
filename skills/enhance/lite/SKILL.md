---
name: enhance-lite
description: 轻量模式——纯润色：仅表达层调整（语序、用词、标点、长短句），不改语义与体裁；零增量（不添加未提及内容、不删要点）。无检索。
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

T1（system.md）：纯润色——只改写表达本身（语序、用词、错别字与标点、长短句），**仅表达层调整，不改语义与体裁**；零增量红线：不添加用户未提及的内容、不删原文要点；自然语言直出，不套 markdown 骨架（长度由原文决定，不注水、不压缩要点）。
检索：无（kind=none，直发）。