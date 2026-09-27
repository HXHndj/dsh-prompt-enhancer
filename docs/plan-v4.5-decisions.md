# v4.5 决策文档：多会话状态隔离修复（发布为 v4.2.3）

> 依据：`docs/audit-session-isolation.md`（2026-09-27 两轮审核，F1–F10）。
> 计划编号沿用文档序列（v4.3/v4.4 计划号已被澄清卡与澄清记录入链两轮占用，其内容折入 [4.1.0] 发布），
> 实际发布版本按语义化版本定为 **4.2.3**（用户拍板 patch——全部为缺陷修复，其中 host 缺参报错属对外行为变更，CHANGELOG 单列申报）。

## 一、用户拍板决策（2026-09-27）

1. **F2 语义**：切档位 ⇒ **只清「切换动作所在会话」的记忆链**（含澄清记录与 optimized 复位），不跨会话。
   ▾ 菜单入口清菜单所在会话；**设置页入口清当前聚焦会话**（保留一个仅此用途的聚焦会话登记；聚焦为 null 时只存配置不清链）。
2. **F3 语义**：清链后在途结果**应用但不入链**——草稿照常替换、optimized 照常置位，但不写链、不写澄清记录（链世代 epoch 实现）。
3. **版本**：4.2.3（patch）。计划文档名沿用序列为 plan-v4.5-decisions.md。
4. **F5 修法**：**持久化 `optimized`**——新键 `dsh-enh-opt:<sessionId>`（值 '1'，缺键即 false），跨刷新/重启保留；store 回收行为维持（不抑制）。

其余按审计建议执行：F1 瞬态帧挂起、真实编辑维持删键（L1 不可逆语义不变）；F4 注入判定去全局改实例本地 liveness；F6 切会话关菜单；F7 删 seen 死键、保留 lastDraft（有读方）；F8 host 三处兜底统一 BAD_ARGS；F9 消费逻辑收敛单函数。

## 二、实现要点（与代码注释一一对应）

### helpers.js

- **`consumeResult(sessionId, draft, inputActions, firstFrame)`**（F1/F9）：result 态消费唯一实现。`draft===enhanced` 无事；`draft===backup`（≠''）回注；**`firstFrame || draft===''` 挂起**（不消费、不删键——瞬态帧=宿主未回灌/实例复用陈旧草稿）；其余（非空、≠两者）= 真实编辑 ⇒ 丢弃 + 删键。`discardResult(sessionId)` 供「草稿非空→空」（发送/手动清空）作废挂起结果。
- **`applyModeSwitch(sessionId, nextMode, paramsPatch)`**（F2/F10）：`changed = configState.value.mode !== nextMode`；saveConfig 整体写入；`changed && sessionId` 时 `clearMemoryChain(sessionId)`。**契约：切档清链唯一入口**。删除 `clearAllMemoryChains`/双 sweep/`bindMemoryChainModeWatch`/装载守卫——config 订阅不再挂清链，启动期磁盘同步（F10）零清链。
- **链世代 epoch**（F3）：store 增 `chainEpoch`；`clearMemoryChain` 顶部 +1；`enhance()` 快照；完成回调仅当 `s.chainEpoch === epoch` 才写链/写澄清记录（结果应用照常）。
- **liveness**（F4）：`enhance()` 增第 7 参 `liveness`（组件 ref），`away = liveness ? liveness.current !== sessionId : false`（缺省=存活，兼容直调）。原 `activeSessionId` 改名收窄为 `focusedSessionId`（唯一消费方 = 设置页切档）。
- **opt 键**（F5）：`optKey/saveOptimizedStore`；写点=完成应用（置 true）与 undo（随链）；删点=clearMemoryChain；`storeFor` 恢复白名单新增（幂等）。
- **seen 死键删除**（F7）：`seenKey/writeSeen/clearSeen` + constants `SEEN_KEY_PREFIX` 整体删除（dead-code-gate GLB 白名单条目同步清理）。

### 组件

- **enhance-button**：`livenessRef`（渲染期刷新 + `[sessionId]` effect 重申 + 卸载置 null）；`[sessionId]` effect 原 activeSession 登记改 `setFocusedSession`；消费 effect 改调 `consumeResult`（自持 `prevConsumeSessionRef` 算 firstFrame）；emptied 分支追加 `discardResult`；`menuOpen` 随 `[sessionId]` 复位（F6）；四处 `enhance` 调用补传 `livenessRef`；`EnhanceMenu` 渲染新增 `sessionId` prop。
- **enhance-menu**：`applyMode` 改调 `applyModeSwitch(props.sessionId, next, { params })`。
- **params-tab**：模式下拉 onChange 改调 `applyModeSwitch(getFocusedSession(), next, { params })`。
- **enhance-bar**：消费 effect 改调 `consumeResult`（同款 firstFrame ref）；ClarifyPanel 增自持 `livenessRef` 并随两处 `enhance` 调用传入。

### host（enhance-handlers.js）

- F8：`enhance`/`cancel`/`enhance/progress` 三处 sessionId 兜底统一为缺/空 ⇒ `{ok:false, code:'BAD_ARGS'}`（原 'unknown'/'unknown'/'' 三种不一致兜底；progress 对合法 sessionId 无记录仍 NO_RECORD）。物理行数不变（A194-1：src/host 7 文件 34 行口径）。

## 三、持久化键清单（v4.2.3 起，均按会话隔离）

| 键 | 生命周期 | 变更 |
| :-- | :-- | :-- |
| `dsh-enh-result:<sid>` | 结果暂存 `{b,e}` | 不变（消费删键规则见 F1） |
| `dsh-enh-memory:<sid>` | 记忆链 | 不变 |
| `dsh-enh-clarify:<sid>` | 已答澄清 | 不变（随链同寿命） |
| `dsh-enh-opt:<sid>` | 「已优化」标记 | **新增（F5）** |
| `dsh.enhance.seen.<sid>` | —— | **删除（F7，死键）** |

## 四、测试与验证

- `test/client-enhance-flow.test.cjs`：**92 用例全绿、0 todo**（原 AUDIT-05/06 两条 todo 缺陷证据转正为回归断言；新增 AUDIT-13（消费 parity 双顺序）/14（config-only 零清链）/15（实例本地 away）/16（opt 键全链路）；MEM-06/V1/V42-28/AUDIT-03/09 按新语义反转；wiring 断言重写钉住 applyModeSwitch 两入口与 consumeResult 收敛）。
- 全量 `npm test` **290/290 / 0 fail**；`npm run gate` 通过 30 · 冲突 0；`build:host --check` / `build:client --check` 一致（版本 4.2.3）。

## 五、已知边界（承接审计）

- 聚焦会话登记在双实例并存时仍「后挂载者胜」——仅影响设置页切档清哪条链，不影响注入正确性（F4 已把注入判定改实例本地）。
- 多标签页/多窗口同会话并发（同 `sid:seq` 键）本轮不覆盖，维持「纳入下一轮审核」。
