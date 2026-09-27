# v4.4 实施规范:澄清记录入链 + 按钮三态 + 专家档固定记忆

> 用户决策(2026-09-27,三批):
> ① 澄清问答"写入记忆链"——跨轮指**同一段提示词的迭代链内部**(一次链生命周期内的多次优化之间),非跨需求;
> ② 草稿未修改时不显示"继续优化",显示**"重新优化"**(重跑即所见即所得);
> ③ **专家档固定开启记忆**(不受开关控制);
> ④ **✨ 只表示记忆流开关状态**——空输入不再借 ✨ 表意(空输入的可点击性由点击行为自身承担);且**专家档下记忆开关只置灰控件、不置灰标签**。

## 0. 已定决策

| # | 决策 | 影响面 |
|---|---|---|
| V1 | 澄清记录随链持久化:后续**每一次**优化请求都携带(含记忆开关关闭时——澄清独立于开关);刷新随链恢复;三触发清链(发送/手动清空/切模式)一并清除;上限沿用 9 条 | client + host(零改动) |
| V2 | undo **不回退**澄清记录(已答/keep 是用户的事实性决定,非优化产物) | client |
| V3 | 澄清取消(clarifyCancel)只回退草稿与当前未提交题,**不清已入库历史记录**(旧行为误清前轮已答) | client |
| V4 | 按钮三态:首次(✨+模式标签)/ **重新优化**(已优化且草稿正文 === 最近优化结果正文,严格相等)/ 继续优化(已优化且草稿已修改)。判定与 host `computeEditDelta` 同源(差异段为空 ⟺ 逐字节相等) | client |
| V5 | `req.continue` 死字段删除(client 不再发;host 本就不读) | client |
| V6 | 专家档固定开启记忆:存储值**不覆盖**(切回 lite/standard 恢复用户原值),生效路径恒视为开——client 恒携带链、恒写链;host 注入判定恒真 | client + host |
| V7 | 记忆开关 UI 在专家档下置灰 + 提示(设置页下拉与 ▾ 菜单两入口,口径统一为「**标签正常色 + 控件置灰**」);✨ dim 判定专家档恒不灰 | client |
| V9 | **空输入态零专属样式**:✨ 的饱和度是记忆流开关的**唯一**指示通道,空输入不得再借它表意(原 v3.5.3「整键压暗」与 v4.4.1「仅压 ✨」两版规则一并退役,类名 `dsh-enh-btn-empty` 同步删除);空输入的提示只保留原生 `title` | client |
| V8 | 场景 D(全选替换误判继续优化)**未拍板,本轮不动** | — |

## 1. 钉死的协议与判定

```
按钮态(client,enhance-button):
  lastOutput  = memoryRounds 非空 ? rounds[last].output : splitCommand(s.enhanced).body
  isRedo      = optimized === true && splitCommand(draft).body === lastOutput   // 严格相等
  显示        = !optimized ? 首次 : (isRedo ? 重新优化 : 继续优化)

专家档记忆恒开(双侧):
  client: resolveActualMode / 写链 / ✨dim / 开关 UI —— cfg.mode === 'expert' 一律视为 memory:true
  host:   memoryActive = shouldInjectMemory(cfg.memory === true || cfg.mode === 'expert', hasMemory)

澄清记录持久化(client):
  localStorage 键 dsh-enh-clarify:<sessionId>,值 = [{q,a,via},…] JSON(时间序,≤9)
  写入:澄清提交/跳过(roundAnswers 并入 s.clarifyAnswers 时)
  携带:每次 enhance 请求,req.answers = s.clarifyAnswers(非空即发,不再限澄清续跑)
  清除:三触发清链同步 removeItem;undo 保留;clarifyCancel 保留已入库部分
```

## 2. 实现改动点

**host(src/host/enhance-handlers.js)**:仅一处——`memoryActive` 调用点加 `|| cfg.mode === 'expert'`(V6);`shouldInjectMemory` 纯函数签名不变。

**client(src/client/helpers.js)**
1. `resolveActualMode`:`cfg.memory || cfg.mode === 'expert'` 才携带 rounds(V6);
2. 写链:`config.memory || config.mode === 'expert'`(V6);
3. `s.clarifyAnswers` 常驻:终稿成功/失败路径**不再清空**(V1);`enhance` 每次请求非空即发 `req.answers`(V1);删 `req.continue`(V5);
4. `clarifyCancel`:仅回退草稿 + 清 `s.clarify`(当前题),保留 `s.clarifyAnswers` 已入库记录(V3);
5. 持久化:`saveClarifyStore` / `clearClarifyStore` / 恢复逻辑(storeFor,独立于链恢复);`clearMemoryChain` / `clearAllMemoryChains` 同步清澄清键(V1)。

**client(src/client/components/enhance-button.js)**
- idle 态三态判定(V4)+ 文案 `btnRedo` / hover `titleRedo`;
- ✨ dim:专家档恒不 dim(V7);**空输入不改 ✨**(V9)——饱和度单一职责 = 记忆流开关;
- 编辑即丢弃路径清 `s.clarifyAnswers` 的行为改为**保留**(与 V1 一致:草稿被编辑≠用户否决已答事实——仅"结果被丢弃"时旧代码清空,现保留)。

**client(src/client/components/params-tab.js / enhance-menu.js)**:专家档下记忆开关置灰/不可切 + 提示文案(V7);值位恒显示开。**▾ 菜单侧细化(V7/图三·图四)**:行仍 `disabled`(不可点/不进键盘导航),但**标签保持正常色**,置灰只落在开关控件上(`data-locked` 标记 + `opacity:.5`),与设置页「标签正常 + select disabled」同构。

**i18n(src/client/i18n.js)**:`btnRedo` / `titleRedo` / `cfgMemoryExpertLocked`(提示"专家档固定开启记忆")ZH/EN 成对。

**文档**:SKILL.md(专家档固定记忆声明)、README*.md、docs/compatibility-matrix.md。

## 3. 测试

- `test/client-enhance-flow.test.cjs`:按钮三态(首次/重新/继续,含"改回原文变重新");专家档恒携带/恒写链(开关 false);澄清记录持久化/刷新恢复/三触发清除/undo 保留/cancel 不清历史/普通 enhance 携带 answers;`req.continue` 不再发送。
- `test/lib.test.cjs`:enhance-handlers 切片若覆盖 memoryActive——补专家档断言;现有 `req.continue` 相关断言(如有)删除。
- 门禁:sync-prompts --check、build-host/client --check、npm run gate、npm test 全绿。

## 4. 编辑协议

沿用 v4.1 §7:编辑 `.work/decoded/` 副本 → `node --check` → `node .work/encode.mjs <相对路径>` 回写 → 重跑 decode 校验一致。
