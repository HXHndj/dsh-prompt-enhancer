'use strict';
// client-enhance-flow —— 增强完成回调行为级测试（2026-08-24「优化完成但草稿未替换」事故防回归）
// 手法：解码 src/client/helpers.js 单行 chunk，注入浏览器桩（localStorage/host/configState）后
// 求值出内部函数，直接驱动 enhance()/cancelEnhance() 断言写回/暂存/丢弃/失败四路；
// 另加接线契约断言（button/bar 源码必须含关键接线标记），专防 f6fa822 式"注释有、代码无"半成品。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const decodeChunk = (rel) => {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = raw.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*\n$/);
  if (!m) throw new Error('chunk wrapper mismatch: ' + rel);
  return JSON.parse('"' + m[1] + '"');
};

function loadHelpers() {
  const src = decodeChunk('src/client/helpers.js');
  const lsBacking = new Map();
  const localStorageStub = {
    getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
    setItem: (k, v) => lsBacking.set(k, String(v)),
    removeItem: (k) => lsBacking.delete(k),
  };
  const hostStub = {
    calls: [],
    respond: () => ({ ok: true, text: 'OUT' }),
    call(method, args) {
      this.calls.push({ method, args });
      return Promise.resolve(this.respond(method, args));
    },
  };
  const factory = new Function(
    'host', 'configState', 'localStorage', 'MEMORY_ROUNDS_MAX', 'SEEN_KEY_PREFIX',
    src + '\n;return { enhance, undo, cancelEnhance, guardPasses, setActiveSession, getActiveSession, storeFor };'
  );
  const api = factory(hostStub, { value: { memory: false } }, localStorageStub, 4, 'dsh-enh-seen:');
  return { api, hostStub, lsBacking };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const RK = (sid) => 'dsh-enh-result:' + sid;

// ---------- 行为级：完成回调四路 ----------
test('ENH-FLOW stay: 活动会话内完成 → 草稿写回 + result 态 + 结果持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-stay';
  api.setActiveSession(sid); // 关键：登记活动会话（f6fa822 缺失的接线）
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '原文ABC' };
  hostStub.respond = () => ({ ok: true, text: '优化后XYZ' });
  api.enhance(sid, '原文ABC', inputActions, draftRef);
  await flush();
  assert.equal(writes[writes.length - 1], '优化后XYZ', '草稿必须被写回为结果');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.equal(s.backup, '原文ABC');
  assert.ok(lsBacking.has(RK(sid)), 'localStorage 必须持久化结果');
});

test('ENH-FLOW away: 已切走 → 只暂存不写草稿（防串会话）', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-away';
  api.setActiveSession(null);
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '原文' };
  hostStub.respond = () => ({ ok: true, text: '结果Q' });
  api.enhance(sid, '原文', inputActions, draftRef);
  await flush();
  assert.equal(writes.includes('结果Q'), false, '切走后不得写回草稿');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.equal(s.enhanced, '结果Q');
  assert.ok(lsBacking.has(RK(sid)), '暂存也必须持久化（回归恢复依赖）');
});

test('ENH-FLOW edited: 留在会话但用户已编辑 → 丢弃且清持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-edit';
  api.setActiveSession(sid);
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '用户改过的内容' };
  hostStub.respond = () => ({ ok: true, text: '迟到结果' });
  api.enhance(sid, '原文', inputActions, draftRef);
  await flush();
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'idle');
  assert.equal(s.enhanced, '');
  assert.equal(writes.includes('迟到结果'), false, '丢弃路径不得写回');
  assert.equal(lsBacking.has(RK(sid)), false, '丢弃必须清理持久化');
});

// ---------- 行为级：失败与取消 ----------
test('ENH-FLOW error: 失败 → 还原 backup + 错误码 + 清持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-err';
  api.setActiveSession(sid);
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '原文E' };
  hostStub.respond = () => ({ ok: false, code: 'TIMEOUT' });
  api.enhance(sid, '原文E', inputActions, draftRef);
  await flush();
  assert.equal(writes.includes('原文E'), true, '失败必须还原 backup');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'idle');
  assert.equal(s.error, 'TIMEOUT');
  assert.equal(lsBacking.has(RK(sid)), false, '失败必须清理持久化');
});

test('ENH-FLOW cancel: 在途取消 → 还原 backup + 取消 RPC + 清持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-cancel';
  api.setActiveSession(sid);
  lsBacking.set(RK(sid), JSON.stringify({ b: '旧', e: '旧结果' })); // 预置陈旧持久化
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '原文C' };
  hostStub.respond = () => new Promise(() => {}); // 永不完成
  api.enhance(sid, '原文C', inputActions, draftRef);
  await flush();
  api.cancelEnhance(sid, inputActions);
  assert.equal(writes.includes('原文C'), true, '取消必须还原 backup');
  assert.equal(lsBacking.has(RK(sid)), false, '取消必须清理陈旧持久化');
  const cancelCall = hostStub.calls.find((c) => c.method === 'cancel');
  assert.ok(cancelCall, '必须发送 cancel RPC');
});

// ---------- 接线契约：专防"注释有、代码无"（f6fa822 事故类） ----------
test('ENH-FLOW wiring: button 必须登记活动会话且声明 actions ref', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(/setActiveSession\(sessionId\)/.test(btn), 'button 缺 setActiveSession 登记（恒 null → 完成回调恒判已切走）');
  assert.ok(btn.includes('inputActionsRef'), 'button 缺 inputActionsRef 声明（恢复效应将 ReferenceError）');
});
test('ENH-FLOW wiring: bar 卸载不得 cancel 在途优化 + 消费效应须豁免暂存态', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  assert.equal(/host\.call\('cancel'/.test(bar), false, 'bar 卸载残留 cancel——与「后台继续」冲突');
  assert.ok(bar.includes('draft !== s.backup'), 'bar 消费效应缺 backup 豁免（暂存未写回态会被误清）');
});
test('ENH-FLOW wiring: helpers 完成分支三路持久化调用齐备', () => {
  const h = decodeChunk('src/client/helpers.js');
  for (const marker of [
    'saveResultStore(sessionId, s.backup',
    'clearResultStore(sessionId); // v3.3.x 新一轮覆盖旧结果',
    'clearResultStore(sessionId); // v3.3.x-fix：取消',
    'clearResultStore(sessionId); // v3.3.x-fix：丢弃',
  ]) {
    if (!marker) continue;
    assert.ok(h.includes(marker), 'helpers 缺持久化接线标记: ' + marker);
  }
});

// ---------- v3.6.0 分裂按钮（用户拍板）：空输入禁用 + ▾ 菜单接线契约 ----------
test('ENH-FLOW wiring: 空输入主键禁用置灰（「空输入点击=切记忆」隐藏功能删除，记忆开关迁移 ▾ 菜单）', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  // 旧行为必须清空
  assert.equal(btn.includes('saveConfig({ memory: !configState.value.memory })'), false, '空输入点击切记忆必须删除');
  assert.equal(btn.includes('titleMemoryOn'), false, 'titleMemoryOn 死键引用必须清空');
  assert.equal(btn.includes('titleMemoryOff'), false, 'titleMemoryOff 死键引用必须清空');
  // 新行为：空输入 = disabled + 置灰类 + 新提示键
  assert.ok(btn.includes('disabled = true;'), '空输入必须 disabled');
  assert.ok(btn.includes('dsh-enh-btn-empty'), '空输入必须携带置灰类（styles 已定义 .dsh-enh-btn-empty）');
  assert.ok(btn.includes("t('titleEmptyInput')"), '空输入 title 必须用新键 titleEmptyInput');
  // 分裂按钮组装 + 主键状态机保留
  assert.ok(btn.includes('dsh-enh-split'), '必须渲染 [主键][▾] 组合体容器');
  assert.ok(btn.includes('EnhanceMenu'), '必须装配 EnhanceMenu 菜单组件');
  assert.ok(btn.includes("main = React.createElement('button'"), '主键状态机产物必须经 main 变量（enhancing/result/idle 三态共用）');
  assert.ok(btn.includes('setActiveSession(sessionId)'), '主键活动会话登记保留（既有接线契约）');
  assert.ok(btn.includes('inputActionsRef'), '主键 actions ref 保留（既有接线契约）');
});
test('ENH-FLOW wiring: ▾ 菜单 chunk 锚点（数据同源设置页 + 写同一 fallback[0] + 交互契约）', () => {
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  // 数据同源：models/list providers + buildCandidates 候选（与设置页 ModelConfigTab 同源）
  assert.ok(menu.includes("host.call('models/list')"), '菜单模型数据必须经 models/list（与设置页同源）');
  assert.ok(menu.includes('buildCandidates('), '候选必须经 buildCandidates（与设置页同源）');
  // 思考等级：models/resolve 能力表驱动 + F1 纠偏 legacy 门控
  assert.ok(menu.includes("'models/resolve'"), '思考等级必须由 models/resolve 能力表驱动');
  assert.ok(menu.includes('noCache'), '已启用思考条目须 noCache 取新鲜能力表（F1 同款）');
  assert.ok(menu.includes('!legacy'), 'resolve 纠偏必须经 legacy 门控（fallback.length>1 不静默改写）');
  // 状态写回：全部经 saveConfig 写 fallback[0]（与设置页同一状态、双向同步）
  assert.ok(menu.includes('subscribeConfig('), '菜单必须订阅 configState（与设置页互相同步）');
  assert.ok((menu.match(/fallback: \[\{/g) || []).length >= 3, '模型选择/纠偏/思考等级写回都必须落 fallback[0]');
  // 菜单行：记忆开关行（第一行）+ 增强模型区 + 思考等级区
  assert.ok(menu.includes("t('menuMemory')"), '缺记忆开关行');
  assert.ok(menu.includes("t('menuModels')"), '缺增强模型区头');
  assert.ok(menu.includes("t('menuEffort')"), '缺思考等级区头');
  // 交互：Escape / 点击外部关闭、↑/↓ 行间移动、Enter/Tab 选定
  for (const key of ["'Escape'", "'ArrowDown'", "'ArrowUp'", "'Enter'", "'Tab'", "'mousedown'"]) {
    assert.ok(menu.includes(key), '菜单缺交互接线: ' + key);
  }
  // 菜单不放「立即优化」动作行（主键即优化）；失败提示不进菜单
  assert.equal(menu.includes('enhance('), false, '菜单不得携带优化动作（主键即优化）');
  assert.equal(menu.includes('errorKey'), false, '失败分类提示必须走 EnhanceBar 错误条，不进菜单');
  // v3.6.0 评审修复回归锚点：开合驱动必须存在（旧缺陷：onClick 恒 close + 菜单无条件渲染 → 常驻展开遮挡输入区）
  assert.ok(menu.includes('setOpen((v) => !v)'), '触发器必须切换 open（防「常驻展开」回归）');
  assert.ok(menu.includes("open ? React.createElement('div', { className: 'dsh-enh-menu'"), '菜单面必须按 open 条件渲染（关闭态不挂载 .dsh-enh-menu）');
  assert.ok(menu.includes("'aria-expanded': open ? 'true' : 'false'"), 'aria-expanded 必须绑定 open（不得硬编码）');
  assert.ok(menu.includes('if (!open) return;'), '键盘处理关闭态必须放行（触发器保留原生开合）');
  // v3.6.0 评审修复(d)(minor) 锚点：fresh 首开继承 / 空组跳过 / 不预高亮
  assert.ok(menu.includes("'models/current'"), 'fresh profile 首开必须经 models/current 继承 fallback[0]（否则模型行无 ✓）');
  assert.ok(menu.includes('DEFAULT_MODEL_CHAIN[0]'), '继承无选中/RPC 拒绝必须回退官方默认第一项（与设置页同源）');
  assert.ok(menu.includes('configState.fresh = false'), '继承写回必须置 fresh=false（设置页不再重复继承）');
  assert.ok(menu.includes('if (models.length === 0) continue;'), '空提供方组必须跳过子头（对齐 DSH 飞出不渲染空组）');
  assert.ok(menu.includes('setActiveIdx(-1)'), '打开不得预高亮首行（对齐 DSH——无悬停无高亮）');
  assert.ok(menu.includes('clampedIdx < 0 ? 0 :'), '↑/↓ 必须兼容 -1 起始（↓ 进首行 / ↑ 进末行）');
});
