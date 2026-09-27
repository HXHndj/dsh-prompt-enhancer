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

// v4.1：MEMORY_ROUNDS_MAX=3、MEMORY_KEY_PREFIX（持久化键）与 subscribeConfig（切模式清链监听）
// 都是 helpers.js 的自由变量——与 bundle 内一致地按注入参数提供；localStorage 桩补 key()/length
// （切模式清链会清扫已释放会话的 dsh-enh-memory:* 残键）。
const MEMORY_ROUNDS_MAX_TEST = 3;
const MK = (sid) => 'dsh-enh-memory:' + sid;
// v4.4（V1）：澄清记录持久化键前缀（与链键独立、生命周期同步）
const CK = (sid) => 'dsh-enh-clarify:' + sid;

function loadHelpers(configValue, opts) {
  const src = decodeChunk('src/client/helpers.js');
  const lsBacking = (opts && opts.lsBacking) || new Map();
  const localStorageStub = {
    getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
    setItem: (k, v) => lsBacking.set(k, String(v)),
    removeItem: (k) => lsBacking.delete(k),
    key: (i) => (i >= 0 && i < lsBacking.size ? [...lsBacking.keys()][i] : null),
    get length() { return lsBacking.size; },
  };
  const hostStub = {
    calls: [],
    respond: () => ({ ok: true, text: 'OUT' }),
    call(method, args) {
      this.calls.push({ method, args });
      return Promise.resolve(this.respond(method, args));
    },
  };
  const cfgListeners = new Set();
  const subscribeConfig = (fn) => { cfgListeners.add(fn); return () => cfgListeners.delete(fn); };
  const configState = { value: configValue || { memory: false } };
  // v4.2.3（F2·审计处置）：applyModeSwitch 依赖 saveConfig——桩与真实语义对齐
  //（configState 整体替换 + 广播 config 监听），供切档清链作用域用例直接驱动
  const saveConfig = (patch) => {
    configState.value = Object.assign({}, configState.value, patch);
    for (const fn of [...cfgListeners]) fn();
  };
  const factory = new Function(
    'host', 'configState', 'localStorage', 'MEMORY_ROUNDS_MAX', 'MEMORY_KEY_PREFIX', 'saveConfig',
    src + '\n;return { enhance, undo, cancelEnhance, clarifyCancel, guardPasses, setFocusedSession, getFocusedSession,'
    + ' storeFor, subscribe, notify, releaseStoreIfIdle, safeSetDraft, clearMemoryChain, consumeResult, discardResult,'
    + ' applyModeSwitch, memoryKey, saveMemoryStore, saveOptimizedStore, resolveActualMode, splitCommand, errorKey };'
  );
  const api = factory(hostStub, configState, localStorageStub, MEMORY_ROUNDS_MAX_TEST, 'dsh-enh-memory:', saveConfig);
  const fireConfig = () => { for (const fn of [...cfgListeners]) fn(); };
  return { api, hostStub, lsBacking, configState, fireConfig, subscribeConfig, localStorageStub };
}

// v4.1（D1 清链触发①）：EnhanceButton 的「草稿被清空」效应是 React effect——用迷你 React 运行时
//（useState/useRef/useEffect + deps 浅比较）驱动真实组件函数，不改组件代码即可断言跳变语义：
// 首屏草稿本就为空不得误清（D2 刷新保链），「非空 → 空」跳变（发送/手动清空）才清链。
// v4.2-r2（task-4）：opts.inputActions 覆盖 harness 的 noop setDraft（撤销/重灌分支要读回草稿写入值）；
// opts 省略时行为与既有用例完全一致。
function loadButton(helpers, sessionId, opts) {
  const src = decodeChunk('src/client/components/enhance-button.js');
  // v4.2.3（审计处置）：button chunk 自由符号表随 F1/F2/F4/F7 改造更新——
  // 删 setActiveSession/getActiveSession/clearSeen/clearResultStore，增 setFocusedSession/
  // getFocusedSession/consumeResult/discardResult。clearResultCalls 记账保留（恒空）：
  // 消费路径的删键断言改走 lsBacking 结果键（helpers.consumeResult 内部真删）。
  const clearResultCalls = [];
  let cells = [];
  let cursor = 0;
  let pending = [];
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
    useState(init) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { kind: 'state', value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useRef(init) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { kind: 'ref', value: { current: init } };
      return cells[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => d !== prev.deps[k]);
      cells[i] = { kind: 'effect', deps };
      if (changed) pending.push(fn);
    },
  };
  const t = (k) => k;
  const noop = () => {};
  const factory = new Function(
    'React', 'makeT', 'subscribe', 'subscribeConfig', 'storeFor', 'notify', 'releaseStoreIfIdle', 'setFocusedSession',
    'getFocusedSession', 'safeSetDraft', 'setLastDraft', 'guardPasses', 'modeShortLabel', 'configState', 'EnhanceMenu',
    'clarifyCancel', 'enhance', 'host', 'clearMemoryChain', 'discardResult', 'cancelEnhance', 'errorKey', 'undo', 'timerSvc',
    'consumeResult',
    src + '\n;return EnhanceButton;'
  );
  const EnhanceButton = factory(
    React, (p) => (p && typeof p.t === 'function' ? p.t : t), helpers.api.subscribe, helpers.subscribeConfig,
    helpers.api.storeFor, helpers.api.notify, helpers.api.releaseStoreIfIdle, helpers.api.setFocusedSession,
    helpers.api.getFocusedSession, helpers.api.safeSetDraft, noop, helpers.api.guardPasses, (tt, mode) => mode,
    helpers.configState, () => null, helpers.api.clarifyCancel, helpers.api.enhance, helpers.hostStub,
    helpers.api.clearMemoryChain, helpers.api.discardResult, helpers.api.cancelEnhance, (code) => code, helpers.api.undo,
    // v4.2（task-4）：enhancing 态的 500ms 进度轮询经 bundle 注入的 ctx timer 服务（chunk 内为自由变量）——
    // 单测桩一个空 disposer，使「增强中」渲染路径可达（否则引用未声明标识符 ReferenceError）
    { interval: () => () => {} },
    helpers.api.consumeResult
  );
  // render(draft, phase, overrideSid)：模拟一次渲染并执行 deps 变化的 effect（React 语义最小子集）；
  // overrideSid 模拟「渲染器复用同一实例、只换 sessionId prop」的会话切换
  const render = (draft, phase, overrideSid) => {
    const sid = overrideSid || sessionId;
    cursor = 0;
    pending = [];
    const el = EnhanceButton({
      sessionId: sid,
      useSession: () => ({ sessionId: sid }),
      useInput: () => ({ draft, phase: phase || 'plain' }),
      inputActions: (opts && opts.inputActions) || { setDraft: noop },
      t,
    });
    const fns = pending;
    pending = [];
    for (const fn of fns) fn();
    return el;
  };
  return { render, clearResultCalls };
}

// v4.2（task-12）：错误文案断言需要真实 ZH 文案表（此前失败路径只断言错误码，未覆盖上屏文案）
const ZH = new Function(decodeChunk('src/client/i18n.js') + '\n;return ZH;')();

// v4.2（task-12）：EnhanceBar 的文案拼接属渲染逻辑——用同一套迷你 React 运行时驱动真实组件函数，
// 直接读回错误行 <span> 文本（专防「优化失败：优化失败」式双前缀回归）
function loadBar(helpers, sessionId) {
  const src = decodeChunk('src/client/components/enhance-bar.js');
  let cells = [];
  let cursor = 0;
  let pending = [];
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
    useState(init) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    // v4.2.3（F1/F9）：bar 消费首帧基线 prevConsumeSessionRef 用到 useRef
    useRef(init) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { value: { current: init } };
      return cells[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => d !== prev.deps[k]);
      cells[i] = { kind: 'effect', deps };
      if (changed) pending.push(fn);
    },
  };
  const t = (k) => (ZH[k] !== undefined ? ZH[k] : k);
  const noop = () => {};
  const factory = new Function(
    'React', 'makeT', 'subscribe', 'storeFor', 'notify', 'releaseStoreIfIdle', 'errorKey', 'consumeResult',
    src + '\n;return EnhanceBar;'
  );
  const EnhanceBar = factory(
    React, (p) => (p && typeof p.t === 'function' ? p.t : t), helpers.api.subscribe,
    helpers.api.storeFor, helpers.api.notify, helpers.api.releaseStoreIfIdle, helpers.api.errorKey,
    helpers.api.consumeResult
  );
  const render = (draft) => {
    cursor = 0;
    pending = [];
    const el = EnhanceBar({
      sessionId,
      useSession: () => ({ sessionId }),
      useInput: () => ({ draft, phase: 'plain' }),
      inputActions: { setDraft: noop },
      t,
    });
    const fns = pending;
    pending = [];
    for (const fn of fns) fn();
    return el;
  };
  return { render };
}

// 迷你 React 元素树 → 纯文本
const textOf = (el) => {
  if (el === null || el === undefined) return '';
  if (typeof el === 'string') return el;
  if (Array.isArray(el)) return el.map(textOf).join('');
  if (typeof el === 'object') return textOf(el.children);
  return '';
};

// v4.3（task-14）：ClarifyPanel 的 kind 分支 / keep 选择行 / 提交可用性 / 跳过载荷都是渲染逻辑——
// 用同一套迷你 React 运行时驱动真实组件函数（含真实 helpers.enhance，可直接断言发往 host 的载荷）
function loadClarify(helpers, sessionId) {
  const src = decodeChunk('src/client/components/enhance-bar.js');
  let cells = [];
  let cursor = 0;
  let pending = [];
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
    useState(init) {
      const i = cursor++;
      if (cells[i] === undefined) cells[i] = { value: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = cells[i];
      const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length
        || deps.some((d, k) => d !== prev.deps[k]);
      cells[i] = { kind: 'effect', deps };
      if (changed) pending.push(fn);
    },
  };
  const t = (k) => (ZH[k] !== undefined ? ZH[k] : k);
  const noop = () => {};
  const factory = new Function(
    'React', 'makeT', 'subscribe', 'storeFor', 'notify', 'releaseStoreIfIdle', 'enhance', 'clarifyCancel',
    src + '\n;return ClarifyPanel;'
  );
  const ClarifyPanel = factory(
    React, (p) => (p && typeof p.t === 'function' ? p.t : t), helpers.api.subscribe,
    helpers.api.storeFor, helpers.api.notify, helpers.api.releaseStoreIfIdle, helpers.api.enhance,
    helpers.api.clarifyCancel
  );
  const render = (draft) => {
    cursor = 0;
    pending = [];
    const el = ClarifyPanel({
      sessionId,
      useSession: () => ({ sessionId }),
      useInput: () => ({ draft: draft === undefined ? '草稿' : draft, phase: 'plain' }),
      inputActions: { setDraft: noop },
      t,
    });
    const fns = pending;
    pending = [];
    for (const fn of fns) fn();
    return el;
  };
  return { render };
}

// 迷你 React 元素树：按谓词收集节点（用于定位 keep 行 / 按钮 / kind 提示）
const collectEls = (el, pred, out) => {
  const acc = out || [];
  if (el === null || el === undefined) return acc;
  if (Array.isArray(el)) { for (const x of el) collectEls(x, pred, acc); return acc; }
  if (typeof el !== 'object') return acc;
  if (pred(el)) acc.push(el);
  collectEls(el.children, pred, acc);
  return acc;
};
const hasClass = (el, cls) => typeof el.props.className === 'string'
  && el.props.className.split(' ').indexOf(cls) !== -1;
const buttonsWithText = (el, text) => collectEls(el, (x) => x.type === 'button' && textOf(x) === text);

const flush = () => new Promise((r) => setTimeout(r, 0));
const RK = (sid) => 'dsh-enh-result:' + sid;

// ---------- 行为级：完成回调四路 ----------
test('ENH-FLOW stay: 活动会话内完成 → 草稿写回 + result 态 + 结果持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-stay';
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
  // v4.2.3（F4）：away 判定改实例本地 liveness（第 7 参）——{current:null} 模拟「发起实例已卸载/已换会话」
  const liveness = { current: null };
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '原文' };
  hostStub.respond = () => ({ ok: true, text: '结果Q' });
  api.enhance(sid, '原文', inputActions, draftRef, undefined, undefined, liveness);
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

// ---------- v4.0.0 专家档澄清卡：clarify 分支（信号/提交/跳过/取消四路 + 记忆链并入） ----------
test('ENH-CLARIFY signal: 澄清信号 → phase=clarify + 题目入 store + 不写草稿/不置 optimized/backup 保留', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-cl';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '含歧义的草稿' };
  hostStub.respond = () => ({ ok: true, clarify: [{ q: '「它」指哪个函数？', options: ['parseConfig', 'loadPlugins'] }], text: '' });
  api.enhance(sid, '含歧义的草稿', inputActions, draftRef);
  await flush();
  assert.deepEqual(writes, [], '澄清信号不得写草稿（等用户作答）');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'clarify');
  assert.deepEqual(s.clarify, [{ q: '「它」指哪个函数？', options: ['parseConfig', 'loadPlugins'] }], '题目必须入 store 供 ClarifyPanel 渲染');
  assert.equal(s.backup, '含歧义的草稿', 'backup 必须保留供取消恢复');
  assert.equal(s.optimized, false, '澄清轮不得置 optimized');
  assert.deepEqual(s.memoryRounds, [], '澄清轮不得写记忆');
  assert.equal(lsBacking.has(RK(sid)), false, '澄清轮不持久化结果');
});

test('ENH-CLARIFY submit: 提交 → 带 answers（含 via）重调 + 终稿应用；澄清问答**不入链**（D17）', async () => {
  const { api, hostStub, lsBacking } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-submit';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '草稿' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    return call === 1
      ? { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }, { q: 'Q2', options: ['a', 'b'] }], text: '' }
      : { ok: true, text: '终稿' };
  };
  api.enhance(sid, '草稿', inputActions, draftRef);
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify');
  // 提交（仅回答 Q1「点选选项」，Q2 保持原文开放性）→ 带 answers 重调
  api.enhance(sid, '草稿', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls.length, 2, '必须重调 enhance');
  assert.deepEqual(enhanceCalls[1].args.answers, [{ q: 'Q1', a: 'a', via: 'option' }], '第二跳必须携带 answers（含 via）');
  assert.equal(enhanceCalls[1].args.skip, undefined, '提交路径不得携带 skip');
  assert.equal(writes[writes.length - 1], '终稿', '终稿必须写回草稿');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.equal(s.optimized, true);
  assert.deepEqual(s.memoryRounds, [
    { input: '草稿', output: '终稿' },
  ], 'v4.1（D17/§2.6）：澄清问答不入 memoryRounds——链里只有优化轮');
  // v4.4（V1·澄清记录入链）：终稿应用后**不再清空**——已答记录随链存活，持久化到 dsh-enh-clarify:
  assert.deepEqual(s.clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V1）：终稿应用后澄清记录保留（跨轮存活，直到三触发清链）');
  assert.deepEqual(s.clarify, [], '终稿到达后旧题目必须清空');
  assert.deepEqual(
    JSON.parse(lsBacking.get(MK(sid))),
    [{ input: '草稿', output: '终稿' }],
    '§2.3：入链即写持久化键（值 = rounds 数组）'
  );
  assert.deepEqual(JSON.parse(lsBacking.get(CK(sid))), [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V1）：澄清记录持久化键随提交写入');
  assert.ok(lsBacking.has(RK(sid)), '结果键独立持久化');
  // v4.4（V1）：后续**普通**优化（继续优化，无 clarifyOpts）仍携带已入库问答——跨轮生效
  draftRef.current = '终稿改';
  api.enhance(sid, '终稿改', inputActions, draftRef);
  await flush();
  const third = hostStub.calls.filter((c) => c.method === 'enhance')[2];
  assert.deepEqual(third.args.answers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V1）：继续优化请求仍携带澄清记录（专家档「不重复问」跨轮成立）');
  assert.equal(third.args.skip, undefined, '普通优化不带 skip');
});

test('ENH-CLARIFY skip: 跳过 → 带 skip:true 重调 + 终稿应用 + 澄清问答不入链（歧义保持原文）', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-skip';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '草稿S' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    return call === 1
      ? { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' }
      : { ok: true, text: '跳过终稿' };
  };
  api.enhance(sid, '草稿S', inputActions, draftRef);
  await flush();
  api.enhance(sid, '草稿S', inputActions, draftRef, { skip: true });
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls[1].args.skip, true, '跳过路径必须携带 skip:true');
  assert.equal(enhanceCalls[1].args.answers, undefined, '跳过路径不得携带 answers');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.memoryRounds, [{ input: '草稿S', output: '跳过终稿' }], 'skip 不产生记忆条目（与 host 同口径）');
});

test('ENH-CLARIFY cancel: 取消澄清 → 恢复 backup + phase=idle + 清题目，不发 cancel RPC', async () => {
  const { api, hostStub } = loadHelpers();
  const sid = 'sess-clcancel';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '草稿X' };
  hostStub.respond = () => ({ ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' });
  api.enhance(sid, '草稿X', inputActions, draftRef);
  await flush();
  api.clarifyCancel(sid, inputActions);
  assert.deepEqual(writes, ['草稿X'], '取消必须恢复 backup（放弃本次）');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'idle');
  assert.deepEqual(s.clarify, [], '取消必须清空题目');
  assert.equal(s.optimized, false);
  assert.deepEqual(s.memoryRounds, []);
  assert.equal(hostStub.calls.some((c) => c.method === 'cancel'), false, '澄清取消无在途请求，不得发 cancel RPC');
});

test('ENH-CLARIFY multi-round: 连续两轮澄清 → 第二跳 answers 合并前轮问答 + 全部问答先于终稿入链', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-multi';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '草稿M' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    if (call === 2) return { ok: true, clarify: [{ q: 'Q2', options: ['c', 'd'] }], text: '' };
    return { ok: true, text: '两轮终稿' };
  };
  api.enhance(sid, '草稿M', inputActions, draftRef); // 第 1 跳 → clarify 轮 1
  await flush();
  api.enhance(sid, '草稿M', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] }); // 第 2 跳 → clarify 轮 2
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify', '第二轮仍是澄清');
  api.enhance(sid, '草稿M', inputActions, draftRef, { answers: [{ q: 'Q2', a: 'c', via: 'custom' }] }); // 第 3 跳 → 终稿
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.deepEqual(
    enhanceCalls[2].args.answers,
    [{ q: 'Q1', a: 'a', via: 'option' }, { q: 'Q2', a: 'c', via: 'custom' }],
    '第三跳必须携带合并后的全部问答（前轮不丢；via 各自保留，证据正文可见）'
  );
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.memoryRounds, [
    { input: '草稿M', output: '两轮终稿' },
  ], 'v4.1（D17）：两轮澄清问答都不入链——链里只有优化轮，问答走独立通道');
});

test('ENH-CLARIFY skip keeps staged: 第二轮改跳过 → skip + 历史问答仍携带；前轮问答保留（不入链，独立通道）', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-skipkeep';
  const inputActions = { setDraft: (v) => {} };
  const draftRef = { current: '草稿K' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    if (call === 2) return { ok: true, clarify: [{ q: 'Q2', options: ['c', 'd'] }], text: '' };
    if (call === 3) return { ok: true, clarify: [{ q: 'Q3', options: ['e', 'f'] }], text: '' }; // 跳过后续跑仍可再澄清
    return { ok: true, text: '跳过终稿K' };
  };
  api.enhance(sid, '草稿K', inputActions, draftRef);
  await flush();
  api.enhance(sid, '草稿K', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  api.enhance(sid, '草稿K', inputActions, draftRef, { skip: true }); // 第二轮跳过（host 仍可再抛第三问）
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls[2].args.skip, true, '第三跳必须携带 skip:true');
  // v4.4（V1）：跳过路径**仍携带历史已入库问答**（独立通道不因 skip 丢弃；本轮无新 keep
  // 条目时 req.answers = 已暂存历史——「跳过的是本轮歧义，不否决前轮已答」）
  assert.deepEqual(enhanceCalls[2].args.answers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V1）：skip 续跑携带历史澄清记录（跨轮「不重复问」不因跳过中断）');
  const mid = api.storeFor(sid);
  assert.equal(mid.phase, 'clarify', '跳过后续跑仍可进入下一轮澄清');
  assert.deepEqual(mid.clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'skip 不清已暂存问答（不否决前轮已答）——独立通道，不占 memoryRounds');
  assert.deepEqual(mid.memoryRounds, [], 'D17：跳过与问答都不入链（链只在优化结果应用后产生）');
  // 下一跳提交新答 → 前轮 Q1 与本轮 Q2 合并透传，终稿应用后链里只有优化轮
  api.enhance(sid, '草稿K', inputActions, draftRef, { answers: [{ q: 'Q2', a: 'c', via: 'custom' }] });
  await flush();
  const all = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.deepEqual(all[3].args.answers, [
    { q: 'Q1', a: 'a', via: 'option' },
    { q: 'Q2', a: 'c', via: 'custom' },
  ], '暂存问答合并透传（前轮不丢；via 各自保留）');
  assert.deepEqual(api.storeFor(sid).memoryRounds, [{ input: '草稿K', output: '跳过终稿K' }],
    'v4.1（D17）：链里只有优化轮，问答一条不入');
});

test('ENH-CLARIFY cap9: 合计口径封顶 9 条（保留最近）——4 轮满答后 host 收到 9 条全量而非截前 3', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-cap9';
  const inputActions = { setDraft: (v) => {} };
  const draftRef = { current: '草稿9' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    if (call <= 4) {
      return {
        ok: true,
        clarify: [
          { q: 'Q' + call + 'a', options: ['1', '2'] },
          { q: 'Q' + call + 'b', options: ['1', '2'] },
          { q: 'Q' + call + 'c', options: ['1', '2'] },
        ],
        text: '',
      };
    }
    return { ok: true, text: '终稿9' };
  };
  api.enhance(sid, '草稿9', inputActions, draftRef);
  await flush();
  for (let round = 1; round <= 4; round++) {
    api.enhance(sid, '草稿9', inputActions, draftRef, {
      answers: [
        { q: 'Q' + round + 'a', a: 'a' + round },
        { q: 'Q' + round + 'b', a: 'b' + round },
        { q: 'Q' + round + 'c', a: 'c' + round },
      ],
    });
    await flush();
  }
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls.length, 5, '1 次首轮 + 4 次澄清续跑');
  // v4.0.1（评审修复·跟进）：合并总量按合计口径封顶 9（3 题/轮 × ≤3 轮），超限保留最近——
  // 第 4 轮提交时暂存 = 12 → 保留最近 9（Q1 轮让位，Q2..Q4 轮全量透传 host，时序不乱）
  assert.equal(enhanceCalls[4].args.answers.length, 9, '合计口径 9：整体透传不截前 3');
  assert.deepEqual(enhanceCalls[4].args.answers[0], { q: 'Q2a', a: 'a2' }, '超限保留最近（最早一轮让位）');
  assert.deepEqual(enhanceCalls[4].args.answers[8], { q: 'Q4c', a: 'c4' }, '时序不乱（前轮在前）');
  const s = api.storeFor(sid);
  // v4.1（D17/§2.6）：12 条问答全部走独立通道（req.answers 封顶 9），**一条都不占** memoryRounds——
  // 链里只有优化轮（本轮终稿 1 条）
  assert.deepEqual(s.memoryRounds, [
    { input: '草稿9', output: '终稿9' },
  ], 'memoryRounds 只含优化轮：4 轮 × 3 题澄清问答一条都不入链（D17 独立通道）');
});

test('ENH-CLARIFY cap9 合同: host answers 上限必须为合计口径 slice(-9) 且透传 via，与 client 封顶对齐', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src/host/enhance-handlers.js'), 'utf8');
  const hostSrc = JSON.parse('"' + host.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*$/)[1] + '"');
  // v4.1：host 侧改按 §1 归一化 {q,a,via}——断言只锚「合计口径 9」与「via 透传」两条跨层契约
  //（不锁宿主格式细节，避免与 host-impl 的注释/换行调整互相绊倒）；v4.3：via 白名单加 'keep'、a 允许空串
  assert.ok(/\.slice\(-9\)/.test(hostSrc), 'host answers 必须为合计口径 slice(-9)（旧 slice(0,3) 会把后轮新答案截出证据正文，违背 §三.2c）');
  assert.ok(/q: String\(x\.q\), a: String\(x\.a/.test(hostSrc), 'host 必须按 {q,a} 归一化答案');
  assert.ok(/x\.via === 'option' \|\| x\.via === 'custom'/.test(hostSrc) && /x\.via === 'keep'/.test(hostSrc), '§1/§4：host 必须透传合法 via（option/custom/keep），非法/缺失省略');
  assert.ok(/typeof x\.a === 'string'/.test(hostSrc), '§4：host 过滤不得再要求 a 非空（keep 条目 a="" 必须放行）');
  const h = decodeChunk('src/client/helpers.js');
  assert.ok(h.includes('.concat(roundAnswers).slice(-9)'), 'client 暂存必须同口径封顶 9（保留最近），与 host 对齐');
});

test('ENH-CLARIFY wiring: ClarifyPanel 挂 dock 槽位 + 主键 clarify 态 + i18n ZH/EN 成对', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  const btn = decodeChunk('src/client/components/enhance-button.js');
  const app = decodeChunk('src/client/app.js');
  const i18n = decodeChunk('src/client/i18n.js');
  assert.ok(bar.includes('function ClarifyPanel'), 'bar chunk 缺 ClarifyPanel 组件');
  assert.ok(bar.includes("enhance(sessionId, draftRef.current, inputActions, draftRef, { answers: picked }, undefined, livenessRef)"), '提交按钮必须带 answers 重调 enhance（v4.2.3：第 7 参 livenessRef）');
  // v4.3（§4.4）：跳过载荷升级为 skip:true + 全部题 keep 条目（保守策略），行为级断言见 CLARIFY-V43-04
  assert.ok(bar.includes('{ skip: true, answers: keepAll }'), '跳过按钮必须带 skip:true + keep 条目重调');
  assert.ok(bar.includes('clarifyCancel(sessionId, inputActions)'), '取消按钮必须走 clarifyCancel');
  // v4.2（task-11）：取消从 footer 三按钮收进 header 图标按钮——footer 只留「跳过 + 提交」，
  // 取消改由 clarifyCancelAria 承载 aria 标签
  assert.ok(bar.includes("t('clarifySubmit')") && bar.includes("t('clarifySkip')") && bar.includes("t('clarifyCancelAria')"), '按钮文案键（提交并继续/跳过直接优化/取消 aria）缺一不可');
  assert.equal(bar.includes("t('cancel')"), false, 'v4.2：footer 第三按钮「取消」必须移除（原生把取消收进 header iconButton）');
  // v4.2：每题 = button[role=radio] 选项 + autosize textarea 自由输入（原生 ask-user 形态，不再用 label+input）
  assert.ok(bar.includes("role: 'radio'") && bar.includes("'aria-checked'"), '选项必须为 button[role=radio] 且用 aria-checked 表达选中');
  assert.ok(bar.includes("'textarea'") && bar.includes('rows: 1'), '自由输入必须为 textarea rows=1（原生 autosize 形态）');
  assert.equal(/type: 'radio'/.test(bar) || /type: 'text'/.test(bar), false, 'v4.2：不得再用原生 input[type=radio]/[type=text] 渲染选项与自由输入');
  // v4.1（D16/§1）：答案按用户动作带 via——点选 = option / 自由输入 = custom（原样回传，不按文本猜）
  assert.ok(bar.includes("via: viaOption ? 'option' : 'custom'"), '答案必须带 via（option/custom）');
  assert.ok(bar.includes("via: 'option'") && bar.includes("via: 'custom'"), '两个设置点（radio onChange / 自由输入 onChange）都必须显式写 via');
  // v4.1（§2.7 零作答防护）：一题未答 → 提交按钮禁用 + submit 直接返回（双保险）
  assert.ok(bar.includes('disabled: picked.length === 0'), '零作答必须禁用「提交并继续」');
  assert.ok(bar.includes('if (picked.length === 0) return;'), 'submit 必须在零作答时直接返回（不发请求）');
  assert.ok(bar.includes("t('clarifySubmitDisabled')"), '零作答禁用态必须有解释文案键');
  // v4.0.1（评审修复·阻断）：槽位组件常驻挂载（不 clarify 时渲染 null 不卸载）——答案必须按轮
  // 渲染期同步（questions 引用变化即重置），不得依赖只在首挂载求值的 useState 惰性初始化
  assert.equal(/React\.useState\(\(\) =>\s*[\s\S]{0,80}clarify\.map/.test(bar), false, 'answers 不得再用惰性初始化（首挂载 phase 恒 idle → 恒空数组，作答失效）');
  assert.ok(bar.includes('roundRef.current = questions') && bar.includes("questions ? questions.map(() => ({ a: '', via: 'custom' })) : []"), 'answers 必须按轮渲染期同步（换轮/扩容重置；元素形态 {a, via}）');
  // v4.0.1（评审修复·低危）：clarify 期间草稿被改写/清空 → 本轮作废（题目与草稿不错位续跑）
  assert.ok(bar.includes("s.phase === 'clarify' && draft !== s.backup"), 'bar 消费效应必须覆盖 clarify（草稿偏离 backup 即作废）');
  assert.ok(btn.includes("if (s.phase === 'clarify') {"), 'button 发送清空效应必须作废 clarify 卡');
  // v4.0.1（评审修复·提示收敛）：resultFallback 死机制删除（文案与 result 相同、无 {model} 占位）
  assert.equal(btn.includes("t('resultFallback')"), false, '按钮不得再调用 resultFallback（{model} 替换恒 no-op）');
  assert.equal(btn.includes('prettifyModel('), false, '按钮不得再调用 prettifyModel（唯一消费者已删）');
  assert.equal(i18n.includes('resultFallback:'), false, 'resultFallback 死键必须删除（ZH/EN）');
  // v4.0.1（评审修复·轻）：测速文案不得残留旧档称谓（基础/轻量模式已删）
  assert.equal(i18n.includes('基础模式预计约') || i18n.includes('base mode est.'), false, '测速文案残留旧档称谓');
  assert.ok(i18n.includes("menuMemory: '记忆流'") && i18n.includes("menuMemory: 'Memory chain'"), 'menuMemory ZH 必须统一为「记忆流」（EN 保持 Memory chain）');
  assert.ok(app.includes("'prompt-enhance-clarify'") && app.includes('ClarifyPanel'), 'app 缺 clarify 的 conversation.input.dock 槽位注册');
  assert.ok(btn.includes("phase === 'clarify'"), '主键缺 clarify 态分支');
  assert.ok(btn.includes('clarifyCancel(sessionId, inputActions)'), '主键 clarify 态必须可点击取消');
  assert.ok(btn.includes("t('btnClarify')") && btn.includes("t('titleClarify')"), '主键 clarify 态缺文案键');
  for (const k of [
    "clarifyTitle: '需要澄清'", "clarifySubmit: '提交并继续'", "clarifySkip: '跳过直接优化'", "clarifyFreePlaceholder: '或输入你自己的答案…'",
    "clarifyTitle: 'Clarification needed'", "clarifySubmit: 'Submit & continue'", "clarifySkip: 'Skip & optimize'", "clarifyFreePlaceholder: 'Or type your own answer…'",
  ]) {
    assert.ok(i18n.includes(k), 'i18n 缺 clarify 键文案（ZH/EN 须成对）: ' + k);
  }
  // v4.1（§2.7）：零作答禁用态文案 ZH/EN 成对
  assert.ok(i18n.includes('clarifySubmitDisabled:') && (i18n.match(/clarifySubmitDisabled:/g) || []).length === 2,
    '零作答禁用文案必须 ZH/EN 成对');
});

// ---------- v4.2（task-11·reports/06）：错误行 / 澄清卡改原生 dock / ask-user 形态 ----------
test('UI42-01 dock 外壳: 两个 dock 条目都套 .dsh-enh-dock（宽度收敛 + margin auto 居中，修左偏根因）', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  const css = decodeChunk('src/client/styles.js');
  assert.ok(css.includes('.dsh-enh-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px)*2 - var(--dsh-composer-dock-inset,8px)*4)'),
    'styles 缺 .dsh-enh-dock 宽度收敛（composerStack align-items:stretch 造成的左偏未修）');
  assert.ok(css.includes('max-width:calc(var(--dsh-composer-card-max-width,920px) - var(--dsh-composer-dock-inset,8px)*4);margin:6px auto}'),
    '.dsh-enh-dock 缺 max-width 收敛 / margin auto 居中');
  assert.equal((bar.match(/className: 'dsh-enh-dock'/g) || []).length, 2, '错误行与澄清卡的最外层根元素都必须套 .dsh-enh-dock');
  // 旧左偏痕迹必须清除（限定到具体选择器：padding:5px 14px 在 .dsh-plg-btn 中合法存在，不做全局断言）
  assert.equal(css.includes('.dsh-enh-bar{display:flex;align-items:center;gap:10px;padding:5px 14px'), false, '旧 .dsh-enh-bar 规则（无宽度收敛）必须删除');
  assert.equal(css.includes('margin:6px 14px'), false, '澄清卡旧 margin:6px 14px 必须删除（改由外壳居中）');
});

test('UI42-02 错误行: 单色 menu 面板 + 右对齐纯文字动作按钮（role=status 保留在行上）', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  const css = decodeChunk('src/client/styles.js');
  assert.ok(bar.includes("className: 'dsh-enh-bar dsh-enh-bar-error', role: 'status'"), '错误行结构须为 div.dsh-enh-bar.dsh-enh-bar-error[role=status]（外壳内层）');
  assert.ok(css.includes('.dsh-enh-bar{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;padding:6px 12px;border-radius:var(--dsw-radius-lg,16px)'), '错误行未按原生 dock 面板配方（flex + 6/12 padding + 100% 宽 + lg 圆角）');
  assert.ok(css.includes('background:var(--dsw-specific-menu') && css.includes('box-shadow:var(--dsw-elevation-panel)'), '错误行未用原生 menu 面板底 / panel elevation');
  assert.equal(css.includes('line-height:16px;color:var(--dsw-alias-state-error-primary)}'), false, '错误行不得再用错误色小字（原生无 error 面板 token —— 保持单色面板）');
  assert.ok(css.includes('.dsh-enh-bar-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:24px;padding:0 2px;margin-left:auto;cursor:pointer;font-family:inherit}'),
    '动作按钮未改为右对齐纯文字按钮（margin-left:auto / 无描边）');
  assert.ok(css.includes('.dsh-enh-bar-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-radius:6px'), '动作按钮 hover 未按规格（interactive 底 + 6px 圆角）');
});

test('UI42-03 澄清卡: 原生 ask-user 卡形态结构契约（head/cancel/note/opt/dot/autosize/foot）', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  const css = decodeChunk('src/client/styles.js');
  const i18n = decodeChunk('src/client/i18n.js');
  // 卡体（ask-user 配方）
  assert.ok(css.includes('.dsh-enh-clarify{display:flex;flex-direction:column;box-sizing:border-box;width:100%;max-height:min(60vh,520px);overflow:auto;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-specific-input-major'),
    '卡体未按 ask-user 配方（xl 圆角 / input-major 底 / max-height 60vh）');
  assert.ok(css.includes('border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-panel)'), '卡体缺 .5px 细描边或 panel elevation');
  // 头部 + 24px 图标取消（footer 第三按钮退役）
  assert.ok(bar.includes("className: 'dsh-enh-clarify-head'") && bar.includes("className: 'dsh-enh-clarify-title'"), '缺头部/标题结构');
  assert.ok(bar.includes("className: 'dsh-enh-clarify-cancel'") && bar.includes("t('clarifyCancelAria')") && bar.includes("'✕'"), '缺 header 24px 图标取消按钮（含 clarifyCancelAria 标签）');
  assert.ok(css.includes('.dsh-enh-clarify-cancel{width:24px;height:24px'), '取消图标按钮未按 24×24 规格');
  assert.ok(css.includes('.dsh-enh-clarify-head{display:flex;align-items:center;gap:8px;padding:12px 8px 6px 16px}'), '头部几何未按规格');
  // 说明行 / 题区
  assert.ok(css.includes('.dsh-enh-clarify-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:0 16px 8px}'), '说明行未按规格');
  assert.ok(css.includes('.dsh-enh-clarify-q{padding:4px 12px 0}') && css.includes('.dsh-enh-clarify-qtext{font-size:14px;line-height:22px;padding:4px 4px 6px'), '题区/题干未按规格');
  // 选项：button[role=radio] + aria-checked + 20px 圆点
  assert.ok(bar.includes("'aria-checked': checked ? 'true' : 'false'"), '选项必须以 aria-checked 表达选中态');
  assert.ok(bar.includes("className: 'dsh-enh-clarify-dot'") && bar.includes("checked ? '✓' : ''"), '选项行首必须为圆点且选中显示 ✓');
  assert.ok(css.includes('.dsh-enh-clarify-opt[aria-checked="true"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}'), '选中态样式未按规格（aria-checked 驱动）');
  assert.ok(css.includes('.dsh-enh-clarify-dot{width:20px;height:20px;flex:none;border-radius:50%;border:.5px solid var(--dsw-alias-border-l4)'), '圆点样式未按规格');
  // 自由输入：autosize textarea
  assert.ok(bar.includes('autoGrow(e.target)') && bar.includes("el.style.height = 'auto'") && bar.includes('el.scrollHeight'), '自由输入缺 autosize（height:auto → scrollHeight）');
  assert.ok(css.includes('.dsh-enh-clarify-free{width:100%;box-sizing:border-box;margin:6px 0 0;padding:8px 12px;'), '自由输入盒模型未按规格');
  assert.ok(css.includes('resize:none;max-height:120px'), 'textarea 未按 rows=1/resize:none/max-height:120px 规格');
  // 底部按钮组：跳过(outline) + 提交(primary)
  assert.ok(bar.includes("className: 'dsh-enh-clarify-foot'"), '缺底部按钮组容器');
  assert.ok(bar.includes("'dsh-enh-clarify-btn dsh-enh-clarify-btn-outline'") && bar.includes("'dsh-enh-clarify-btn dsh-enh-clarify-btn-primary'"), 'footer 必须为 跳过(outline) + 提交(primary)');
  assert.ok(css.includes('.dsh-enh-clarify-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 12px 12px}'), 'footer 几何未按规格');
  assert.ok(css.includes('.dsh-enh-clarify-btn{height:36px;padding:0 14px;border:0;'), '按钮未按原生 Button.md（36px 高 / 0 14px）');
  assert.ok(css.includes('.dsh-enh-clarify-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}'), '主按钮未用原生 button-primary-fill');
  assert.ok(css.includes('.dsh-enh-clarify-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}'), '主按钮 hover 未用 button-primary-hover');
  assert.ok(css.includes('.dsh-enh-clarify-btn:disabled{opacity:.4;cursor:not-allowed}'), '禁用态未按原生 Button 原语（opacity:.4 + not-allowed）');
  // 旧结构样式清除
  assert.equal(css.includes('.dsh-enh-clarify-actions'), false, '旧 .dsh-enh-clarify-actions 规则必须删除');
  assert.equal(css.includes('.dsh-enh-clarify-opt input[type="radio"]'), false, '旧 radio 输入框样式必须删除（原生不用 input[type=radio]）');
  assert.equal(css.includes('.dsh-enh-clarify-btn:disabled{opacity:.5'), false, '旧 v4.1 禁用透明度（.5）必须替换为原生 .4');
  // 范围纪律（task-11「不做」清单）：主键 ✨ 区与既有状态样式不受牵连
  assert.ok(css.includes('.dsh-enh-btn-clarify{'), '主键 clarify 态样式不得删除（不在本次范围）');
  assert.ok(css.includes('.dsh-enh-status{') && css.includes('.dsh-enh-progress{'), '✨ 按钮区 .dsh-enh-status/.dsh-enh-progress 不得改动');
  // i18n 成对
  assert.equal((i18n.match(/clarifyCancelAria:/g) || []).length, 2, 'clarifyCancelAria 必须 ZH/EN 成对');
  assert.ok(i18n.includes("clarifyCancelAria: '取消澄清'") && i18n.includes("clarifyCancelAria: 'Cancel clarification'"), 'clarifyCancelAria 文案不符（ZH/EN）');
});

// ---------- v4.2（task-12）：错误提示文案规范化（未映射码 + 双重前缀） ----------
test('ERRMAP-01 映射: errorKey 补 host 新码 CLARIFY_MALFORMED / NO_RECORD（未知码仍回退 errUNKNOWN）', () => {
  const { api } = loadHelpers({ memory: false });
  assert.equal(api.errorKey('CLARIFY_MALFORMED'), 'errCLARIFY_MALFORMED', 'host v4.1 新码未映射 → 显示成通用失败（实测「优化失败：优化失败」）');
  assert.equal(api.errorKey('NO_RECORD'), 'errNO_RECORD', 'host 码 NO_RECORD 未映射');
  assert.equal(api.errorKey('TIMEOUT'), 'errTIMEOUT', '既有映射不得回归');
  assert.equal(api.errorKey('ALL_MODELS_UNAVAILABLE'), 'errAllModels', '既有映射不得回归');
  assert.equal(api.errorKey('SOME_FUTURE_CODE'), 'errUNKNOWN', '未知码仍回退 errUNKNOWN（兜底不删）');
  assert.equal(api.errorKey(undefined), 'errUNKNOWN');
  // host 侧实际会 return 的码必须全部可映射——防下一个「未映射码」引起同类缺陷
  for (const code of ['GUARD', 'NO_LLM', 'NO_MODEL', 'ALL_MODELS_UNAVAILABLE', 'CLARIFY_MALFORMED', 'EMPTY_RESPONSE', 'OUTPUT_TOO_LONG', 'LLM_FAILED', 'NO_RECORD']) {
    assert.notEqual(api.errorKey(code), 'errUNKNOWN', 'host 码 ' + code + ' 在 client 未映射');
  }
});

test('ERRMAP-02 行为: 错误行文案 = 前缀 + 具体原因；errUNKNOWN 只显示一次（不双前缀）', () => {
  const h = loadHelpers({ memory: false });
  const sid = 'sess-errmap';
  const bar = loadBar(h, sid);
  const rowText = (code) => {
    h.api.storeFor(sid).error = code;
    const dock = bar.render('草稿');
    assert.equal(dock.props.className, 'dsh-enh-dock', 'v4.2-A 外壳不得回退');
    const row = dock.children[0];
    assert.equal(row.props.className, 'dsh-enh-bar dsh-enh-bar-error', 'v4.2-A 错误行形态不得回退');
    assert.equal(row.props.role, 'status', 'live region 语义不得回退');
    return textOf(row.children[0]);
  };
  assert.equal(rowText('CLARIFY_MALFORMED'), ZH.errorPrefix + ZH.errCLARIFY_MALFORMED, 'host 新码必须显示具体原因（带前缀）');
  assert.equal(rowText('NO_RECORD'), ZH.errorPrefix + ZH.errNO_RECORD, 'NO_RECORD 同上');
  assert.equal(rowText('TIMEOUT'), ZH.errorPrefix + ZH.errTIMEOUT, '既有码保持「优化失败：<原因>」');
  const unknown = rowText('TOTALLY_NEW_CODE');
  assert.equal(unknown, ZH.errUNKNOWN, '未映射码只显示 errUNKNOWN 文案');
  assert.equal(unknown, '优化失败', '实机文案 = 单个「优化失败」');
  assert.equal(unknown.indexOf('：'), -1, '不得出现双前缀（文案内不应含全角冒号）');
  assert.equal(rowText('UNKNOWN'), '优化失败', 'helpers 对未映射码落库的 UNKNOWN 同样不双前缀');
  // 前缀分支的接线锚（源码级，防「注释有、代码无」）
  const barSrc = decodeChunk('src/client/components/enhance-bar.js');
  assert.ok(barSrc.includes("errKey === 'errUNKNOWN' ? t('errUNKNOWN') : t('errorPrefix') + t(errKey)"), '前缀分支必须存在（errUNKNOWN 不加前缀）');
  // i18n ZH/EN 成对
  const i18n = decodeChunk('src/client/i18n.js');
  assert.equal((i18n.match(/errCLARIFY_MALFORMED:/g) || []).length, 2, 'errCLARIFY_MALFORMED 必须 ZH/EN 成对');
  assert.equal((i18n.match(/errNO_RECORD:/g) || []).length, 2, 'errNO_RECORD 必须 ZH/EN 成对');
  assert.ok(i18n.includes("errCLARIFY_MALFORMED: '澄清信号解析失败，请重试或跳过'"), 'errCLARIFY_MALFORMED ZH 文案不符');
  assert.ok(i18n.includes("errNO_RECORD: '优化请求已失效'"), 'errNO_RECORD ZH 文案不符');
  assert.ok(i18n.includes("errCLARIFY_MALFORMED: 'Clarification signal could not be parsed"), 'errCLARIFY_MALFORMED EN 文案缺失');
  assert.ok(i18n.includes("errNO_RECORD: 'Optimization request is no longer valid'"), 'errNO_RECORD EN 文案不符');
});

// ---------- v4.3（task-14）：澄清卡按 kind 渲染 + keep 通道 + 保守跳过 ----------
test('CLARIFY-V43-01 helpers: keep 条目不被过滤（a 为空仍送达 host）、skip 与 answers 可并存', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-keep';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿K' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    return call === 1
      ? { ok: true, clarify: [{ kind: 'gap', q: '缺失信息Q' }, { kind: 'ambiguity', q: '歧义Q', options: ['a', 'b'] }], text: '' }
      : { ok: true, text: '终稿K' };
  };
  api.enhance(sid, '草稿K', inputActions, draftRef);
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify');
  // 提交：Q1 选「保留原句」（a:'' via:'keep'）+ Q2 点选选项
  api.enhance(sid, '草稿K', inputActions, draftRef, { answers: [{ q: '缺失信息Q', a: '', via: 'keep' }, { q: '歧义Q', a: 'a', via: 'option' }] });
  await flush();
  const calls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.deepEqual(calls[1].args.answers, [
    { q: '缺失信息Q', a: '', via: 'keep' },
    { q: '歧义Q', a: 'a', via: 'option' },
  ], '§2：keep 条目（a 为空）必须保留并送达 host（旧过滤 x.a.trim()!=="" 会整条丢弃）');
  assert.equal(calls[1].args.skip, undefined, '纯提交路径不携带 skip');
  // skip + answers 并存（「跳过直接优化」= skip:true + 全部题 keep）
  const sid2 = 'sess-keep-skip';
  const draftRef2 = { current: '草稿S' };
  let call2 = 0;
  hostStub.respond = () => {
    call2 += 1;
    return call2 === 1 ? { ok: true, clarify: [{ kind: 'gap', q: 'Q1' }, { kind: 'ambiguity', q: 'Q2', options: ['x', 'y'] }], text: '' } : { ok: true, text: '终稿S' };
  };
  api.enhance(sid2, '草稿S', inputActions, draftRef2);
  await flush();
  api.enhance(sid2, '草稿S', inputActions, draftRef2, { skip: true, answers: [{ q: 'Q1', a: '', via: 'keep' }, { q: 'Q2', a: '', via: 'keep' }] });
  await flush();
  const skipCall = hostStub.calls.filter((c) => c.method === 'enhance' && c.args.sessionId === sid2)[1];
  assert.equal(skipCall.args.skip, true, '§2/§4.4：跳过必须携带 skip:true');
  assert.deepEqual(skipCall.args.answers, [{ q: 'Q1', a: '', via: 'keep' }, { q: 'Q2', a: '', via: 'keep' }],
    '§2/§4.4：skip 与 answers 必须并存（旧 else-if 互斥会丢掉 keep 条目）');
  // 零作答兜底不回归：仅传空 answers 且无 skip → 降级为 skip（绝不发「既无 answers 又无 skip」）
  const sid3 = 'sess-keep-zero';
  const draftRef3 = { current: '草稿Z' };
  let call3 = 0;
  hostStub.respond = () => {
    call3 += 1;
    return call3 === 1 ? { ok: true, clarify: [{ kind: 'gap', q: 'QZ' }], text: '' } : { ok: true, text: '终稿Z' };
  };
  api.enhance(sid3, '草稿Z', inputActions, draftRef3);
  await flush();
  api.enhance(sid3, '草稿Z', inputActions, draftRef3, { answers: [] });
  await flush();
  const zeroCall = hostStub.calls.filter((c) => c.method === 'enhance' && c.args.sessionId === sid3)[1];
  assert.equal(zeroCall.args.answers, undefined, '零作答不得携带 answers');
  assert.equal(zeroCall.args.skip, true, '§2.7 零作答防护保持（降级 skip）');
});

test('CLARIFY-V43-02 渲染: kind 分支（gap = 保留原句行 + 自由输入；ambiguity = 选项 + 自由输入；缺省按 ambiguity）', () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-kind-render';
  const draftRef = { current: '草稿R' };
  const s = h.api.storeFor(sid);
  s.phase = 'clarify';
  s.backup = '草稿R';
  s.clarify = [
    { kind: 'gap', q: '缺失信息？' },
    { kind: 'ambiguity', q: '「它」指谁？', options: ['parseConfig', 'loadPlugins'] },
    { q: '无 kind 题？', options: ['p', 'q'] },
  ];
  const panel = loadClarify(h, sid);
  const el = panel.render('草稿R');
  assert.ok(el, '澄清卡必须渲染');
  const questions = collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-q'));
  assert.equal(questions.length, 3, '三题都要渲染');
  assert.deepEqual(questions.map((q) => q.props['data-kind']), ['gap', 'ambiguity', 'ambiguity'], 'kind 缺省 = ambiguity（§1）');
  // kind 提示（极轻文案）
  const kinds = collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-kind')).map((x) => textOf(x));
  assert.deepEqual(kinds, [ZH.clarifyKindGap, ZH.clarifyKindAmbiguity, ZH.clarifyKindAmbiguity], '每题 kind 提示文案不符');
  // 「保留原句」行只在 gap 题出现
  const keepRows = collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-keep'));
  assert.equal(keepRows.length, 1, '§4.2：仅 gap 题有「保留原句」行');
  assert.equal(textOf(keepRows[0]), ZH.clarifyKeep, '保留原句行文案不符');
  assert.equal(keepRows[0].props.role, 'radio', '保留原句行必须为 radio 形态');
  assert.equal(keepRows[0].props['aria-checked'], 'false', '初始未选中');
  // ambiguity 题选项行齐备（2 个）+ gap 题无选项仅有 keep 行
  const optRows = collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-opt') && !hasClass(x, 'dsh-enh-clarify-keep'));
  assert.deepEqual(optRows.map((x) => textOf(x)), ['parseConfig', 'loadPlugins', 'p', 'q'], 'ambiguity 选项必须渲染（gap 无 options → 无建议行）');
  // 每题一个自由输入 textarea
  assert.equal(collectEls(el, (x) => x.type === 'textarea').length, 3, '每题一个自由输入框');
  const src = decodeChunk('src/client/components/enhance-bar.js');
  assert.ok(src.includes("const kind = q.kind === 'gap' ? 'gap' : 'ambiguity'"), 'kind 分支接线缺失（缺省必须按 ambiguity）');
});

test('CLARIFY-V43-03 提交可用性: 全未答 → 禁用且不请求；选保留原句 → 可用且载荷 {a:"", via:"keep"}', () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-keep-submit';
  const s = h.api.storeFor(sid);
  s.phase = 'clarify';
  s.backup = '草稿C';
  s.clarify = [{ kind: 'gap', q: '缺失信息？' }, { kind: 'ambiguity', q: '歧义？', options: ['a', 'b'] }];
  const panel = loadClarify(h, sid);
  let el = panel.render('草稿C');
  const submitOf = (tree) => buttonsWithText(tree, ZH.clarifySubmit)[0];
  const before = submitOf(el);
  assert.equal(before.props.disabled, true, '§4.3：全部未作答且未选保留 → 提交必须禁用');
  before.props.onClick(); // 程序化强制点击
  assert.equal(h.hostStub.calls.filter((c) => c.method === 'enhance').length, 0, '禁用态点击不得发出请求（零作答防护）');
  // 选第 1 题「保留原句」
  const keepRow = collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-keep'))[0];
  keepRow.props.onClick();
  el = panel.render('草稿C');
  const after = submitOf(el);
  assert.equal(after.props.disabled, false, '§4.3：已选保留原句 → 提交可用');
  assert.equal(collectEls(el, (x) => hasClass(x, 'dsh-enh-clarify-keep'))[0].props['aria-checked'], 'true', '保留原句行选中态须由 aria-checked 表达');
  after.props.onClick();
  const call = h.hostStub.calls.filter((c) => c.method === 'enhance')[0];
  assert.deepEqual(call.args.answers, [{ q: '缺失信息？', a: '', via: 'keep' }], '§2：keep 载荷 = {q, a:"", via:"keep"}');
  assert.equal(call.args.skip, undefined, '逐题提交路径不携带 skip');
});

test('CLARIFY-V43-04 跳过: 跳过直接优化 = skip:true + 全部题 keep 条目（保守策略，不替用户选边）', () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-keep-skip-ui';
  const s = h.api.storeFor(sid);
  s.phase = 'clarify';
  s.backup = '草稿S';
  s.clarify = [{ kind: 'gap', q: 'Q1' }, { kind: 'ambiguity', q: 'Q2', options: ['x', 'y'] }];
  const panel = loadClarify(h, sid);
  const el = panel.render('草稿S');
  const skipBtn = buttonsWithText(el, ZH.clarifySkip)[0];
  assert.ok(skipBtn, '缺「跳过直接优化」按钮');
  assert.equal(skipBtn.props.disabled, undefined, '跳过按钮恒可用（不受零作答禁用影响）');
  skipBtn.props.onClick();
  const call = h.hostStub.calls.filter((c) => c.method === 'enhance')[0];
  assert.equal(call.args.skip, true, '§4.4：跳过必须携带 skip:true');
  assert.deepEqual(call.args.answers, [{ q: 'Q1', a: '', via: 'keep' }, { q: 'Q2', a: '', via: 'keep' }],
    '§4.4：跳过必须为全部题各发一条 keep 条目（供记忆链去重，下一轮不再追问）');
  // 源码锚（防「注释有、代码无」）
  const src = decodeChunk('src/client/components/enhance-bar.js');
  assert.ok(src.includes('{ skip: true, answers: keepAll }'), '跳过按钮载荷接线缺失');
  assert.ok(src.includes('const keepAll = questions.map((qq) => ({ q: qq.q, a: \'\', via: \'keep\' }))'), 'keepAll 构造缺失');
  const helpers = decodeChunk('src/client/helpers.js');
  assert.ok(helpers.includes("(x.a.trim() !== '' || x.via === 'keep')"), 'helpers 过滤必须放行 keep 条目');
  // v4.4（V1）：answers 携带不再限澄清续跑——已入库非空即随每次请求发出；skip 仍可并存
  assert.ok(helpers.includes('if (s.clarifyAnswers.length > 0) req.answers = s.clarifyAnswers;')
    && helpers.includes('if (clarifyOpts && clarifyOpts.skip === true) req.skip = true;'), 'skip 与 answers 必须可并存（不得再 else-if 互斥）');
});

test('CLARIFY-V43-05 i18n: clarifyKeep / clarifyKindGap / clarifyKindAmbiguity ZH/EN 成对', () => {
  const i18n = decodeChunk('src/client/i18n.js');
  for (const k of ['clarifyKeep', 'clarifyKindGap', 'clarifyKindAmbiguity']) {
    assert.equal((i18n.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 必须 ZH/EN 成对');
  }
  assert.ok(i18n.includes("clarifyKeep: '保留原句'") && i18n.includes("clarifyKeep: 'Keep original'"), 'clarifyKeep 文案不符');
  assert.ok(i18n.includes("clarifyKindGap: '补充信息'") && i18n.includes("clarifyKindGap: 'Missing info'"), 'clarifyKindGap 文案不符');
  assert.ok(i18n.includes("clarifyKindAmbiguity: '澄清歧义'") && i18n.includes("clarifyKindAmbiguity: 'Clarify ambiguity'"), 'clarifyKindAmbiguity 文案不符');
  const css = decodeChunk('src/client/styles.js');
  assert.ok(css.includes('.dsh-enh-clarify-kind{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)'), 'kind 提示样式缺失（12px tertiary 极轻提示）');
});

// ---------- v4.1 记忆流生命周期（§1 常量 / §2 生命周期；D1·D2·D4·D17） ----------
test('MEM-01 constants: 预算三档 [8000,16000,32000] + 默认 8000 + MEMORY_ROUNDS_MAX=3 + 持久化键前缀', () => {
  const c = decodeChunk('src/client/constants.js');
  const { BUDGET_OPTIONS, CONFIG_DEFAULTS, MEMORY_ROUNDS_MAX, MEMORY_KEY_PREFIX } =
    new Function(c + '\n;return { BUDGET_OPTIONS, CONFIG_DEFAULTS, MEMORY_ROUNDS_MAX, MEMORY_KEY_PREFIX };')();
  assert.deepEqual(BUDGET_OPTIONS, [8000, 16000, 32000], '§1/D3：预算三档 = 8000/16000/32000');
  assert.equal(CONFIG_DEFAULTS.context.budgetChars, 8000, '§1：默认预算 = 8000');
  assert.equal(MEMORY_ROUNDS_MAX, 3, '§1/D4：记忆最多三轮（原 4）');
  assert.equal(MEMORY_KEY_PREFIX, 'dsh-enh-memory:', '§2.3：持久化键前缀 = dsh-enh-memory:');
  const s = decodeChunk('src/client/state.js');
  assert.equal(s.includes('ctxCfg.budgetChars === 32000'), false, '§1：必须删除 v4.0.0 的「32000→16000」映射（32000 现为合法档位）');
  assert.ok(s.includes('else v.context.budgetChars = 8000;'), '§1：旧 0/2000/4000/非法/缺省 → 8000');
  assert.ok(s.includes('context: { budgetChars: 8000 }'), '§1：cloneDefaults 默认档同步为 8000');
});

test('MEM-02 push/cap: 优化成功入链 {input:草稿正文, output:结果}，最多三轮（最老让位）+ 每次入链持久化', async () => {
  const { api, hostStub, lsBacking } = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-cap3';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '' };
  let n = 0;
  hostStub.respond = () => ({ ok: true, text: 'OUT' + (++n) });
  for (let i = 1; i <= 4; i++) {
    draftRef.current = 'draft' + i;
    api.enhance(sid, 'draft' + i, inputActions, draftRef);
    await flush();
  }
  const s = api.storeFor(sid);
  assert.deepEqual(s.memoryRounds, [
    { input: 'draft2', output: 'OUT2' },
    { input: 'draft3', output: 'OUT3' },
    { input: 'draft4', output: 'OUT4' },
  ], '§2.4：入链后 while(length > 3) shift()——第 4 轮挤掉最老的 draft1');
  assert.deepEqual(JSON.parse(lsBacking.get(MK(sid))), s.memoryRounds, '§2.3：入链即同步持久化键（值 = rounds 数组）');
  assert.equal(api.storeFor(sid).optimized, true, '§2.5：结果应用 → optimized 与链同生命周期');
});

test('MEM-03 refresh restore: 预置持久化键 → storeFor 恢复链 + optimized=true；首屏空草稿不得误清（D2）', () => {
  const lsBacking = new Map();
  lsBacking.set(MK('sess-restore'), JSON.stringify([{ input: 'a', output: 'A' }, { input: 'b', output: 'B' }]));
  const h = loadHelpers({ memory: true, mode: 'standard' }, { lsBacking });
  const s = h.api.storeFor('sess-restore');
  assert.deepEqual(s.memoryRounds, [{ input: 'a', output: 'A' }, { input: 'b', output: 'B' }], '§2.3/D2：刷新后从 dsh-enh-memory:<sid> 恢复链');
  assert.equal(s.optimized, true, '§2.5：刷新恢复时链非空即视为可继续优化');
  const btn = loadButton(h, 'sess-restore');
  btn.render('', 'plain'); // 刷新后首屏草稿为空
  assert.equal(h.api.storeFor('sess-restore').memoryRounds.length, 2, 'D2：首屏空草稿不是「清空输入框」，不得误清链');
  assert.ok(h.lsBacking.has(MK('sess-restore')), '持久化键必须保留');
  assert.equal(h.api.storeFor('sess-restore').optimized, true, 'optimized 保持（刷新后可继续优化）');
});

test('MEM-04 clear①草稿清空: 非空→空跳变（手动清空）→ 清链 + 删持久化键 + 复位 optimized；结果键不受影响', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-clear-draft';
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: 'a', output: 'A' }];
  s.optimized = true;
  h.api.saveMemoryStore(sid, s.memoryRounds);
  h.lsBacking.set(RK(sid), JSON.stringify({ b: 'a', e: 'A' }));
  const btn = loadButton(h, sid);
  btn.render('a', 'plain');
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '草稿非空不得清链');
  btn.render('', 'plain'); // 手动清空输入框（无发送，phase 全程 plain）
  assert.deepEqual(h.api.storeFor(sid).memoryRounds, [], 'D1：手动清空草稿 → 清链（旧行为不清，缺陷）');
  assert.equal(h.lsBacking.has(MK(sid)), false, '§2.3：清链同步 removeItem');
  assert.equal(h.api.storeFor(sid).optimized, false, '§2.5：清链即复位 optimized');
  assert.ok(h.lsBacking.has(RK(sid)), '§2.3：清链只删记忆键——结果键（dsh-enh-result:）独立保留');
});

test('MEM-05 clear①草稿清空: 发送成功走同一口径；飞行期/发送失败（草稿保留）不清链', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-clear-send';
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: 'x', output: 'X' }];
  s.optimized = true;
  h.api.saveMemoryStore(sid, s.memoryRounds);
  const btn = loadButton(h, sid);
  btn.render('x', 'plain');
  btn.render('x', 'submitting'); // 提交飞行期：草稿未清
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '飞行期（草稿保留）不得清链');
  btn.render('x', 'plain'); // 发送失败：draft 保留、phase 回落
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '发送失败不清链');
  btn.render('', 'plain'); // 发送成功：基座清空 draft → 与手动清空同判
  assert.deepEqual(h.api.storeFor(sid).memoryRounds, [], 'D1：发送成功（草稿被清空）→ 清链');
  assert.equal(h.lsBacking.has(MK(sid)), false, '清链删持久化键');
  assert.equal(h.api.storeFor(sid).optimized, false, '复位 optimized');
});

// v4.2.3（F2/F10·审计处置·用户拍板）：切档位只清「切换动作所在会话」的链——原「config.mode 跳变 ⇒
// 全局清链 + 全前缀残键清扫」已删除（跨会话误伤 + 启动同步误触发）。清链唯一入口 = applyModeSwitch
//（▾ 菜单传菜单所在会话 / 设置页传聚焦会话）；裸 config 变化（含启动磁盘同步）不再触发任何清链。
test('MEM-06 clear②切换模式: applyModeSwitch 只清目标会话的链；同值重选不清、裸 config 跳变不清、他 会话/已释放会话残键全部保留、草稿/结果态不动', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-mode';
  const other = 'sess-mode-other';
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: 'm', output: 'M' }];
  s.optimized = true;
  s.phase = 'result';
  s.backup = 'm';
  s.enhanced = 'M';
  h.api.saveMemoryStore(sid, s.memoryRounds);
  // 另一会话：内存链 + 键都在（挂载中的 B 会话）
  const so = h.api.storeFor(other);
  so.memoryRounds = [{ input: 'o', output: 'O' }];
  so.optimized = true;
  h.api.saveMemoryStore(other, so.memoryRounds);
  // 已释放 store 的会话只剩 localStorage 残键（sess-gone）——新语义下他 会话的键不是垃圾，必须保留
  h.lsBacking.set(MK('sess-gone'), JSON.stringify([{ input: 'g', output: 'G' }]));
  // ① 裸 config 跳变（模拟启动磁盘同步/程序化改值）：不得清任何链
  h.configState.value = Object.assign({}, h.configState.value, { mode: 'expert' });
  h.fireConfig();
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '裸 config.mode 跳变不得清链（F10：启动同步零清链）');
  assert.ok(h.lsBacking.has(MK('sess-gone')), '裸 config 跳动不得删他 会话残键');
  // ② 同值重选（applyModeSwitch 到当前值）：不清
  h.api.applyModeSwitch(sid, 'expert'); // configState 现值已是 expert
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '同值重选不算「切换模式」→ 不清链');
  // ③ 真切换（在会话 sid 里切档）：只清 sid 的链与键；other/sess-gone 原样保留
  h.api.applyModeSwitch(sid, 'lite');
  const after = h.api.storeFor(sid);
  assert.deepEqual(after.memoryRounds, [], '切档位 → 清**本会话**链');
  assert.equal(after.optimized, false, '切档位同时复位 optimized（opt 键同步删）');
  assert.equal(h.lsBacking.has(MK(sid)), false, '清链删本会话持久化键');
  assert.equal(h.lsBacking.has(MK(other)), true, '其他会话的链键必须保留（F2：不跨会话）');
  assert.equal(h.api.storeFor(other).memoryRounds.length, 1, '其他会话的内存链不受切档影响');
  assert.equal(h.lsBacking.has(MK('sess-gone')), true, '已释放会话的残键必须保留（回到该会话链仍在）');
  assert.equal(after.phase, 'result', '§2.2：切档只清链——不动结果态');
  assert.equal(after.enhanced, 'M', '§2.2：切档不动结果（草稿/结果态保持原样）');
  // ④ 聚焦会话为 null（设置页在无会话登记时切档）：只存配置，不清任何链
  h.api.storeFor(other).memoryRounds = [{ input: 'o2', output: 'O2' }];
  h.api.saveMemoryStore(other, h.api.storeFor(other).memoryRounds);
  h.api.setFocusedSession(null);
  h.api.applyModeSwitch(null, 'standard');
  assert.equal(h.api.storeFor(other).memoryRounds.length, 1, 'focused=null 时切档不得清链');
});

test('MEM-11 切会话: 从草稿非空的会话切到草稿为空的新会话 → 不得误清新会话的链（基线按会话重置）', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const a = 'sess-switch-a';
  const b = 'sess-switch-b';
  const sa = h.api.storeFor(a);
  sa.memoryRounds = [{ input: 'a1', output: 'A1' }];
  h.api.saveMemoryStore(a, sa.memoryRounds);
  const sb = h.api.storeFor(b);
  sb.memoryRounds = [{ input: 'b1', output: 'B1' }];
  sb.optimized = true;
  h.api.saveMemoryStore(b, sb.memoryRounds);
  const btn = loadButton(h, a);
  btn.render('a1', 'plain'); // A 会话草稿非空
  btn.render('', 'plain', b); // 复用实例切到 B 会话（B 草稿为空）
  assert.equal(h.api.storeFor(b).memoryRounds.length, 1, '切会话不得把「上一会话的草稿」当成新会话的清空信号');
  assert.ok(h.lsBacking.has(MK(b)), '新会话持久化键必须保留');
  assert.equal(h.api.storeFor(b).optimized, true, '新会话 optimized 不得被误复位');
  assert.equal(h.api.storeFor(a).memoryRounds.length, 1, '原会话链也不受影响');
});

// v4.2（§3.1 undo 放开）：前置放开到 idle + optimized、回退点按「backup 正文 === 末轮 input」选择、
// 链非空即保持 optimized（连环撤销）——旧 D5 口径（仅 result 态 + 恒复位 optimized）已被本轮取代。
test('MEM-07 undo(v4.2 放开): result 态回本轮起点（斜杠前缀保留）+ idle 态放开 + 连环撤销 + 刷新兜底 + 空链空 backup 不动作', async () => {
  // ① result 态：末轮 input === backup 正文 → 回退取 backup（斜杠命令前缀保留）
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-undo';
  const writes = [];
  const inputActions = { setDraft: (v) => writes.push(v) };
  const draftRef = { current: '/deploy 正文A' };
  let n = 0;
  h.hostStub.respond = () => ({ ok: true, text: 'O' + (++n) });
  h.api.enhance(sid, '/deploy 正文A', inputActions, draftRef);
  await flush();
  const s = h.api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.memoryRounds, [{ input: '正文A', output: 'O1' }], '入链只存正文（斜杠前缀剥离，§3.6）');
  assert.deepEqual(writes, ['/deploy O1'], '前置：结果写回草稿（前缀 + 模型输出）');
  h.api.undo(sid, inputActions);
  assert.deepEqual(writes.slice(1), ['/deploy 正文A'], '§3.1：splitCommand(backup).body === 末轮 input → 回退取 backup（前缀保留）');
  assert.equal(s.phase, 'idle');
  assert.equal(s.enhanced, '');
  assert.equal(s.error, null);
  assert.deepEqual(s.memoryRounds, [], '§3.1：只弹最近一轮');
  assert.equal(s.optimized, false, '§3.1：撤到链空 → optimized=false（回首次态）');
  assert.equal(h.lsBacking.has(MK(sid)), false, '§2.3：弹出后同步持久化键（空链即删键）');
  assert.equal(h.lsBacking.has(RK(sid)), false, 'undo 必须清结果持久化键');

  // ② idle 态放开（v4.2 新行为：旧实现 phase !== 'result' 直接 return，结果已消费后无法撤销）
  const sid2 = 'sess-undo-idle';
  const w2 = [];
  const ia2 = { setDraft: (v) => w2.push(v) };
  const dr2 = { current: 'e1' };
  h.api.enhance(sid2, 'e1', ia2, dr2);
  await flush();
  h.api.storeFor(sid2).phase = 'idle'; // 结果已被消费（idle），但链与 optimized 仍在
  const base2 = w2.length; // 结果写回那一笔不计入撤销断言
  h.api.undo(sid2, ia2);
  assert.deepEqual(w2.slice(base2), ['e1'], '§3.1 前置：phase === "idle" && optimized === true 必须放开撤销');
  assert.equal(h.api.storeFor(sid2).phase, 'idle');
  assert.equal(h.api.storeFor(sid2).optimized, false, '链空 → 回首次态');

  // ③ 连环撤销：每步草稿回该轮 input；链非空时 optimized 保持 true，撤到链空才回首次态
  const sid3 = 'sess-undo-chain';
  const w3 = [];
  const ia3 = { setDraft: (v) => w3.push(v) };
  const dr3 = { current: 'd1' };
  for (const d of ['d1', 'd2', 'd3']) {
    dr3.current = d;
    h.api.enhance(sid3, d, ia3, dr3);
    await flush();
  }
  const s3 = h.api.storeFor(sid3);
  assert.equal(s3.phase, 'result');
  assert.equal(s3.memoryRounds.length, 3);
  const base3 = w3.length; // 三轮结果写回不计入撤销断言
  h.api.undo(sid3, ia3); // result 态 → backup('d3') 正文 === 末轮 input → 回退取 backup
  assert.deepEqual(s3.memoryRounds.map((r) => r.input), ['d1', 'd2']);
  assert.equal(s3.optimized, true, '§3.1：链非空保持 optimized=true（连环撤销入口）');
  assert.deepEqual(JSON.parse(h.lsBacking.get(MK(sid3))), s3.memoryRounds, '每步同步持久化键');
  h.api.undo(sid3, ia3); // idle+optimized → backup('d3') !== 末轮 input('d2') → 取 last.input
  assert.deepEqual(s3.memoryRounds.map((r) => r.input), ['d1']);
  assert.equal(s3.optimized, true, '链仍非空 → 仍可继续撤销');
  h.api.undo(sid3, ia3);
  assert.deepEqual(w3.slice(base3), ['d3', 'd2', 'd1'], '§3.1：每步草稿回该轮 input（连环撤销逐轮回退）');
  assert.deepEqual(s3.memoryRounds, []);
  assert.equal(s3.optimized, false, '撤到链空 → 回首次态');
  assert.equal(h.lsBacking.has(MK(sid3)), false, '链空即删持久化键');
  const before = w3.length;
  h.api.undo(sid3, ia3);
  assert.equal(w3.length, before, '链空 + optimized=false → 撤销无动作（不得再写草稿）');
  assert.equal(s3.phase, 'idle');

  // ④ 刷新兜底：backup 已丢（结果键已消费/清除）但链从持久化恢复 → 回退取末轮 input
  const h4 = loadHelpers({ memory: true, mode: 'standard' });
  const sid4 = 'sess-undo-refresh';
  const s4 = h4.api.storeFor(sid4);
  s4.phase = 'idle';
  s4.optimized = true;
  s4.backup = '';
  s4.memoryRounds = [{ input: 'r1', output: 'R1' }, { input: 'r2', output: 'R2' }];
  h4.api.saveMemoryStore(sid4, s4.memoryRounds);
  const w4 = [];
  h4.api.undo(sid4, { setDraft: (v) => w4.push(v) });
  assert.deepEqual(w4, ['r2'], '§3.1/§六：backup 为空 → 回退取末轮 input（斜杠前缀在该边缘丢失）');
  assert.deepEqual(h4.api.storeFor(sid4).memoryRounds, [{ input: 'r1', output: 'R1' }]);
  assert.equal(h4.api.storeFor(sid4).optimized, true, '链仍非空 → 可继续连环撤销');

  // ⑤ 空链 + 空 backup：restore 为空串 → return 不动作（不得把「撤销」退化成静默清空）
  const h5 = loadHelpers({ memory: true, mode: 'standard' });
  const sid5 = 'sess-undo-empty';
  const s5 = h5.api.storeFor(sid5);
  s5.phase = 'idle';
  s5.optimized = true;
  s5.backup = '';
  s5.memoryRounds = [];
  const w5 = [];
  const ia5 = { setDraft: (v) => w5.push(v) };
  h5.api.undo(sid5, ia5);
  assert.deepEqual(w5, [], '§3.1：restore === "" 则 return 不动作');
  assert.equal(s5.phase, 'idle');
  assert.equal(s5.optimized, true, '不动作 = 状态原样');
  s5.phase = 'result';
  h5.api.undo(sid5, ia5);
  assert.deepEqual(w5, [], 'result 态但空链空 backup 同样不动作');
});

test('MEM-08 zero-answer(§2.7): 带 answers 但一题未答 → 按 skip 重跑，绝不发「既无 answers 又无 skip」的请求', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-zero';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿Z' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    return call === 1
      ? { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' }
      : { ok: true, text: '零作答终稿' };
  };
  api.enhance(sid, '草稿Z', inputActions, draftRef);
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify');
  api.enhance(sid, '草稿Z', inputActions, draftRef, { answers: [] }); // 程序化空提交（UI 层已禁用按钮）
  await flush();
  const calls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(calls.length, 2, '必须重调 enhance（不得原地重问）');
  assert.equal(calls[1].args.answers, undefined, '零作答不得携带 answers');
  assert.equal(calls[1].args.skip, true, '§2.7：零作答按 skip 语义重跑（歧义保持原文）');
  assert.equal(api.storeFor(sid).phase, 'result', 'skip 重跑返回终稿 → 正常应用');
  for (const c of calls.slice(1)) {
    assert.ok(Array.isArray(c.args.answers) || c.args.skip === true, '澄清续跑请求必须 answers / skip 二选一');
  }
});

test('MEM-09 via(§1/D16): 自由输入 via=custom 原样回传；点选选项 via=option；非法 via 不臆造（缺省即省略）', async () => {
  const run = async (answer) => {
    const h = loadHelpers({ memory: true, mode: 'expert' });
    const sid = 'sess-via-' + Math.random().toString(36).slice(2);
    const inputActions = { setDraft: () => {} };
    const draftRef = { current: '草稿V' };
    let call = 0;
    h.hostStub.respond = () => {
      call += 1;
      return call === 1
        ? { ok: true, clarify: [{ q: 'Q1', options: ['选项一', '选项二'] }], text: '' }
        : { ok: true, text: '终稿V' };
    };
    h.api.enhance(sid, '草稿V', inputActions, draftRef);
    await flush();
    h.api.enhance(sid, '草稿V', inputActions, draftRef, { answers: [answer] });
    await flush();
    return h.hostStub.calls.filter((c) => c.method === 'enhance')[1].args.answers[0];
  };
  assert.deepEqual(
    await run({ q: 'Q1', a: '我自己的答复（选项一）', via: 'custom' }),
    { q: 'Q1', a: '我自己的答复（选项一）', via: 'custom' },
    '自由输入原样回传且 via=custom（不因文本等于选项而误判为 option）'
  );
  assert.deepEqual(await run({ q: 'Q1', a: '选项二', via: 'option' }), { q: 'Q1', a: '选项二', via: 'option' }, '点选选项 via=option');
  assert.deepEqual(await run({ q: 'Q1', a: 'x', via: 'weird' }), { q: 'Q1', a: 'x' }, '§1：via 为可选字段——非法值不臆造，直接省略');
});

test('MEM-10 D17: 澄清轮 + 2 轮优化 → 链内 3 条全是优化轮（问答不占三轮名额）', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-d17';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿0' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    return { ok: true, text: 'R' + call };
  };
  api.enhance(sid, '草稿0', inputActions, draftRef);
  await flush();
  api.enhance(sid, '草稿0', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  for (const d of ['d1', 'd2']) {
    draftRef.current = d;
    api.enhance(sid, d, inputActions, draftRef);
    await flush();
  }
  const s = api.storeFor(sid);
  assert.deepEqual(s.memoryRounds.map((r) => r.input), ['草稿0', 'd1', 'd2'], '链内全是优化轮草稿正文');
  assert.equal(s.memoryRounds.some((r) => r.input === 'Q1'), false, 'D17/§2.6：澄清问答不在链内（独立通道 req.answers）');
  assert.equal(s.memoryRounds.length, 3, '三轮名额只被优化轮占用');
});


// ---------- 接线契约：专防"注释有、代码无"（f6fa822 事故类） ----------
// v4.2.3（F2/F4·审计处置）：登记语义收窄为 focusedSessionId（唯一消费方 = 设置页切档定位聚焦会话），
// 完成回调的 away 判定改由 button 自持的 livenessRef 承担（不再依赖全局单值）。
test('ENH-FLOW wiring: button 必须登记聚焦会话 + 自持 livenessRef 且声明 actions ref', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(/setFocusedSession\(sessionId\)/.test(btn), 'button 缺 focusedSession 登记（设置页切档清链将找不到目标会话）');
  assert.ok(btn.includes('const livenessRef = React.useState({ current: sessionId })[0]'), 'button 缺实例本地 livenessRef（away 判定回退全局单值）');
  assert.ok(/enhance\(sessionId, draft, inputActions, draftRef,[^;]*livenessRef\)/.test(btn), 'button 的 enhance 调用必须携带 livenessRef（第 7 参）');
  assert.ok(btn.includes('inputActionsRef'), 'button 缺 inputActionsRef 声明（恢复效应将 ReferenceError）');
});
test('ENH-FLOW wiring: bar 卸载不得 cancel 在途优化 + 消费效应收敛 helpers.consumeResult', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  assert.equal(/host\.call\('cancel'/.test(bar), false, 'bar 卸载残留 cancel——与「后台继续」冲突');
  // v4.2.3（F9）：bar 的 result 消费必须走 consumeResult（原私有分叉实现：不删键/无回注——先执行者胜）
  assert.ok(bar.includes('consumeResult(sessionId, draft, inputActions, firstFrame)'), 'bar 消费效应必须收敛到 helpers.consumeResult（与 button 同源）');
  assert.ok(bar.includes('const prevConsumeSessionRef = React.useRef(null)'), 'bar 缺消费首帧基线 ref（F1：切回首帧不得消费）');
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
  // v4.1 记忆链持久化/清链接线（与结果键独立）；v4.2.3（F2）：全局清链/全前缀 sweep 已删
  for (const marker of [
    'function memoryKey(sessionId) { return MEMORY_KEY_PREFIX + sessionId; }',
    'saveMemoryStore(sessionId, s.memoryRounds);',
    'clearMemoryStore(sessionId);',
  ]) {
    assert.ok(h.includes(marker), 'helpers 缺记忆链持久化接线标记: ' + marker);
  }
  assert.equal(h.includes('function clearAllMemoryChains'), false, '全局清链函数必须删除（F2：切档只清当前会话）');
  assert.equal(h.includes('function sweepMemoryStoreKeys'), false, '全前缀残键清扫必须删除（他会话的键不是垃圾）');
});

// v4.1 清链三触发接线契约（行为级用例见 MEM-04~06）→ v4.2.3（F2）：切模式触发改显式入口
test('MEM wiring: 清链三触发的接线标记（草稿跳变 + applyModeSwitch 两入口 + 澄清不入链）', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  const h = decodeChunk('src/client/helpers.js');
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  const params = decodeChunk('src/client/components/params-tab.js');
  const i18n = decodeChunk('src/client/i18n.js');
  // ① 草稿被清空：发送与手动清空统一为 trim 空 + 「非空→空」跳变（首屏空草稿不得误清 → D2）
  assert.ok(btn.includes('const prevDraftRef = React.useRef('), '缺草稿跳变基线 ref');
  assert.ok(btn.includes("const emptied = !sessionChanged && prev.trim() !== ''"), '缺「同会话内 非空→空」跳变判定');
  assert.ok(btn.includes('const prevSessionRef = React.useRef(sessionId)'), '缺会话基线（复用实例换 sessionId 时不得误清）');
  assert.ok(btn.includes('if (emptied || sendSeenRef.current === true)'), '缺统一清链门（发送与手动清空同口径）');
  assert.ok(btn.includes('clearMemoryChain(sessionId)'), '清链必须走 helpers.clearMemoryChain');
  assert.ok(btn.includes('discardResult(sessionId)'), '草稿清空路径必须作废挂起结果（F1 配套）');
  // ② 切档：applyModeSwitch = 唯一清链入口——▾ 菜单传菜单所在会话、设置页传聚焦会话
  assert.ok(h.includes('function applyModeSwitch(sessionId, nextMode, paramsPatch)'), 'helpers 缺 applyModeSwitch 定义');
  assert.ok(h.includes('if (changed && sessionId) clearMemoryChain(sessionId)'), '切档清链必须限定目标会话且仅 mode 真变化时');
  assert.ok(h.includes('const changed = configState.value.mode !== nextMode'), '同值重选不得清链');
  assert.ok(menu.includes('applyModeSwitch(props.sessionId, next,'), '▾ 菜单模式行必须经 applyModeSwitch 传菜单所在会话');
  assert.ok(params.includes('applyModeSwitch(getFocusedSession(), next,'), '设置页模式下拉必须经 applyModeSwitch 传聚焦会话');
  assert.equal(h.includes('function bindMemoryChainModeWatch'), false, 'config 订阅全局清链监听必须删除（F2/F10）');
  // ③ 澄清问答独立通道（D17）+ 轮数上限
  assert.equal(h.includes('for (const qa of s.clarifyAnswers) s.memoryRounds.push'), false, 'D17：澄清问答不得再入 memoryRounds');
  assert.ok(h.includes('while (s.memoryRounds.length > MEMORY_ROUNDS_MAX) s.memoryRounds.shift()'), '入链必须截断到 MEMORY_ROUNDS_MAX');
  // v4.3（§2）：skip 与 answers 不再是 else-if 互斥（跳过 = skip:true + 全部题 keep 条目）；
  // 零作答防护仍在：带 answers 但一题未答 → 降级 skip（绝不发「既无 answers 又无 skip」）
  // v4.4（V1）：answers 携带升级为「已入库非空即随每次请求发出」（不再限澄清续跑）
  assert.ok(h.includes('if (s.clarifyAnswers.length > 0) req.answers = s.clarifyAnswers;')
    && h.includes('if (clarifyOpts && clarifyOpts.skip === true) req.skip = true;')
    && h.includes('else if (clarifyOpts && !hasRoundAnswers && Array.isArray(clarifyOpts.answers)) req.skip = true;'),
    '§2/§2.7：续跑必须可 skip+answers 并存，且零作答降级 skip');
  // i18n：预算三档与记忆流说明 ZH/EN 成对（§5 文案口径）
  assert.ok(i18n.includes('三档 8000/16000/32000') && i18n.includes('(8000/16000/32000, default 8000)'), 'cfgContextNote 预算三档未同步（ZH/EN）');
  assert.ok(i18n.includes('切换优化模式都会清空记忆流') && i18n.includes('switching mode clears the chain'), 'cfgMemoryNote 未写清链三触发（ZH/EN）');
  assert.ok(i18n.includes('最多保留最近三轮') && i18n.includes('at most the last three rounds'), 'cfgMemoryNote 未写三轮上限（ZH/EN）');
  assert.ok(i18n.includes('刷新页面则保留') && i18n.includes('a page refresh keeps it'), 'cfgMemoryNote 未写刷新保留（ZH/EN）');
});

// ---------- v3.6.0 分裂按钮（用户拍板）：空输入禁用 + ▾ 菜单接线契约 ----------
test('ENH-FLOW wiring: 空输入主键 = 可点击开增强设置（禁用态退役；空输入零专属样式，✨ 只表示记忆流）', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  const i18n = decodeChunk('src/client/i18n.js');
  // 旧行为必须清空
  assert.equal(btn.includes('saveConfig({ memory: !configState.value.memory })'), false, '空输入点击切记忆必须删除');
  assert.equal(btn.includes('titleMemoryOn'), false, 'titleMemoryOn 死键引用必须清空');
  assert.equal(btn.includes('titleMemoryOff'), false, 'titleMemoryOff 死键引用必须清空');
  // v3.5.7（用户需求·空输入可点击）：空输入不再是禁用态——点击主键开合 ▾ 增强设置菜单
  assert.equal(btn.includes('disabled = true;'), false, '空输入不得再置 disabled（禁用态已退役）');
  assert.ok(/if \(empty\) \{[\s\S]{0,500}setMenuOpen\(\(v\) => !v\)/.test(btn), '空输入分支必须接线「点击开合菜单」（setMenuOpen 函数式切换）');
  // v4.4.2（用户需求·最终口径）：✨ 的饱和度是记忆流开关的**唯一**指示通道——空输入态不得再有任何专属
  // 样式（v3.5.3 整键压暗 / v4.4.1 仅压 ✨ 两版规则均已退役）：否则「空输入 + 记忆开」会被误读成
  // 「记忆流关」，且与「专家档固定记忆」自相矛盾。此处锁死新契约并防旧规则回归。
  assert.equal(btn.includes('dsh-enh-btn-empty'), false, '空输入专属置灰类必须退役（✨ 只表示记忆流开关）');
  const css = decodeChunk('src/client/styles.js');
  assert.equal(css.includes('dsh-enh-btn-empty'), false, 'styles 不得再定义空输入专属规则（防裸类/防回归）');
  assert.ok(btn.includes("configState.value.memory === true || configState.value.mode === 'expert' ? '' : ' dsh-enh-icon-dim'"), '✨ dim 必须只由记忆流决定（含专家档恒视为开）');
  assert.ok(css.includes('.dsh-enh-icon-dim{filter:saturate(.2)}'), '记忆流「关」的低饱和规则必须保留');
  assert.ok(btn.includes("t('titleEmptyInput')"), '空输入 title 必须用 titleEmptyInput 键');
  // 受控开合：主键与 ▾ 共用同一状态 + 锚点 ref（点击主键不算点击外部）
  assert.ok(btn.includes('open: menuOpen') && btn.includes('onOpenChange: setMenuOpen'), '主键必须以受控方式把 open/onOpenChange 传给 EnhanceMenu');
  assert.ok(btn.includes('ref: mainRef') && btn.includes('anchorRef: mainRef'), '主键必须挂 ref 并作为菜单锚点传入（否则 mousedown 先关 → 菜单关不掉）');
  assert.ok(menu.includes('const menuControlled = typeof props.onOpenChange') && menu.includes('props.anchorRef && props.anchorRef.current'), '菜单侧缺受控开合/锚点豁免接线');
  // 空输入提示文案如实说明点击行为（中英双语）
  assert.ok(i18n.includes("titleEmptyInput: '空输入：点击打开增强设置'") && i18n.includes("titleEmptyInput: 'Empty input — click to open enhancement settings'"), 'titleEmptyInput 文案未同步为「点击打开设置」（ZH/EN）');
  // 分裂按钮组装 + 主键状态机保留
  assert.ok(btn.includes('dsh-enh-split'), '必须渲染 [主键][▾] 组合体容器');
  assert.ok(btn.includes('EnhanceMenu'), '必须装配 EnhanceMenu 菜单组件');
  assert.ok(btn.includes("main = React.createElement('button'"), '主键状态机产物必须经 main 变量（enhancing/result/idle 三态共用）');
  assert.ok(btn.includes('setFocusedSession(sessionId)'), '主键聚焦会话登记保留（v4.2.3：设置页切档定位用）');
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

// ---------- v3.5.6 模式切换（用户需求）：一级第 4 行 + 二级模式面板 + 与设置页同语义 ----------
test('ENH-FLOW wiring: ▾ 菜单「模式切换」一级行 + 二级模式面板（同源文案 + 自定义模板标签 + 档位重置）', () => {
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  const i18n = decodeChunk('src/client/i18n.js');
  // 一级第 4 行：行内当前模式短标签（与输入框主键 ✨ 后同源同文案）+ ›，点击下钻
  assert.ok(menu.includes("t('menuMode')"), '缺「模式切换」行/面板标题 i18n 键');
  assert.ok(menu.includes("drillTo('mode')"), '一级行未接线下钻（drillTo mode）');
  assert.ok(menu.includes('modeShortLabel(t, cfg.mode)'), '行内值必须取模式短标签（与主键标签同源）');
  assert.ok(menu.includes('MODE_VALUES.indexOf(cfg.mode)'), '下钻落点必须定位当前模式行');
  // 二级面板：MODE_OPTIONS 全量（三档 lite/standard/expert）+ 模式全称 + ✓ 当前 + 自定义模板名标签
  assert.ok(menu.includes('for (const m of MODE_OPTIONS)'), '二级面板必须遍历 MODE_OPTIONS');
  assert.ok(menu.includes('modeLabel(t, m.value)'), '面板行必须用模式全称（与设置页下拉同源）');
  assert.ok(menu.includes('customPickIndex(modePick)') && menu.includes('dsh-enh-menu-tag'), '「用户自定义」模式的可辨识标签接线缺失');
  // 与设置页 ParamsTab onChange 同语义：写 config.mode + 重置该档默认运行参数（params 三项）；
  // v4.0.0（预算新语义）：budgetChars 为全局单选，不再随模式重置（MODE_BUDGET_DEFAULT 已删）
  // v4.2.3（F2·审计处置）：切模式改经 helpers.applyModeSwitch（会话级清链唯一入口），不再直调 saveConfig
  assert.ok(menu.includes('MODE_PARAMS_DEFAULT[next]'), '切模式必须重置该档默认运行参数（与设置页同语义）');
  assert.equal(menu.includes('MODE_BUDGET_DEFAULT'), false, 'MODE_BUDGET_DEFAULT 已随预算全局化删除，不得回流');
  assert.ok(menu.includes('applyModeSwitch(props.sessionId, next, {') && menu.includes('params: {'), '切模式必须经 applyModeSwitch 写入 mode + params（v4.2.3：F2 会话级清链入口）');
  assert.equal(/budgetChars\s*:/.test(menu), false, '菜单切模式不得再写 budgetChars 键（全局单选）');
  // 一级行序镜像（努力程度行隐藏时行号漂移 → 返回高亮归位按 key 查）
  assert.ok(menu.includes('rootKeysRef.current = showEffortRow'), '一级行序镜像缺失（返回归位会错位）');
  assert.ok(menu.includes("'mode'") && menu.includes('paneRef.current'), '新增 pane 档位必须纳入 pane 镜像');
  // 联动：i18n 双语键齐备（S-7 全量平衡之外的单点锚）
  assert.ok(i18n.includes("menuMode: '模式切换'") && i18n.includes("menuMode: 'Mode'"), 'menuMode 缺 ZH/EN 之一');
});

// ---------- v4.4（V4 按钮三态 / V1 澄清记录入链 / V6 专家档固定记忆） ----------
// 递归收集元素树文本（loadButton 的 t 为恒等函数 → 按钮文字即 i18n 键名）
function collectText(el, out) {
  const acc = out || [];
  if (!el) return acc;
  if (typeof el === 'string') { acc.push(el); return acc; }
  if (Array.isArray(el)) { for (const c of el) collectText(c, acc); return acc; }
  if (typeof el === 'object' && el.children) collectText(el.children, acc);
  return acc;
}

// ================= v4.2（task-4·§一/§3.2）：双键状态机 =================
// onClick 目标必须可分辨（主键 undo vs enhance；副键 fresh 第 6 参）——记账包装 helpers 的
// enhance/undo 后再装载组件（loadButton 装载时读取 api 属性，包装即生效），不靠源码字符串猜测。
function loadButtonSpy(h, sessionId, opts) {
  const calls = [];
  const realEnhance = h.api.enhance;
  const realUndo = h.api.undo;
  h.api.enhance = function (...args) { calls.push({ fn: 'enhance', args }); return realEnhance.apply(null, args); };
  h.api.undo = function (...args) { calls.push({ fn: 'undo', args }); return realUndo.apply(null, args); };
  const b = loadButton(h, sessionId, opts);
  return { calls, render: b.render, clearResultCalls: b.clearResultCalls };
}
const countOf = (src, needle) => src.split(needle).length - 1;
// 邻近契约：a 之后 ≤max 字符内必须出现 b（替代正则，避免转义歧义）
const windowHas = (src, a, b, max) => {
  const i = src.indexOf(a);
  if (i === -1) return false;
  const j = src.indexOf(b, i);
  return j !== -1 && j - i <= max;
};
const splitOf = (el) => collectEls(el, (x) => hasClass(x, 'dsh-enh-split'))[0];
const mainBtnOf = (el) => collectEls(el, (x) => x.type === 'button' && x.props['aria-label'] === 'enhanceButton')[0];
const auxBtnOf = (el) => collectEls(el, (x) => hasClass(x, 'dsh-enh-aux'))[0];
const classEl = (el, cls) => collectEls(el, (x) => hasClass(x, cls))[0];
// v4.2.1（用户拍板·图标重设计·方案 D 撤回侧）：撤回图标由字体字形改为**内联 SVG 回勾箭头**（开口曲线，
// 与 ⟳ 的闭合圆环在剪影上区分），重新侧保持 ⟳ 字形不变。字形断言统一走语义符号：
//   redo（从零重新优化）= 仍是文本 '⟳'；undo（撤回优化）= SVG ⇒ 记作 '↩'。
// 两侧的**结构差异**由 V42-39 单独锁死（不许两侧都退化成字形、或都退化成同一 SVG）。
const auxGlyphOf = (el) => {
  const a = auxBtnOf(el);
  const icon = a ? classEl(a, 'dsh-enh-aux-icon') : null;
  if (!icon) return null;
  if (collectEls(icon, (x) => x.type === 'svg').length > 0) return '↩';
  return textOf(icon);
};
const sentEnhances = (h) => h.hostStub.calls.filter((c) => c.method === 'enhance');
const lastEnhanceArgs = (h) => {
  const list = sentEnhances(h);
  return list[list.length - 1].args;
};

test('V42-01 双键状态机·首次: ✨+模式短标签、无副键；主键 = enhance（不是 undo）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-first';
  const b = loadButtonSpy(h, sid);
  const el = b.render('草稿', 'plain');
  const main = mainBtnOf(el);
  assert.ok(main, '主键必须仍为 button[aria-label=enhanceButton]');
  assert.equal(auxBtnOf(el), undefined, '§3.2：optimized=false 不得渲染副键');
  const texts = collectText(main);
  assert.ok(texts.includes('✨') && texts.includes('standard'), '首次主键 = ✨ + 模式短标签');
  assert.equal(texts.includes('btnRedo'), false, '首次不得显示「重新优化」');
  assert.equal(texts.includes('btnContinue'), false, '首次不得显示「继续优化」');
  assert.equal(texts.includes('result'), false, '首次不得显示「撤销优化」产物');
  assert.equal(main.props.disabled, false, '非空草稿可点（guardPasses 通过）');
  main.props.onClick();
  await flush();
  assert.equal(b.calls.length, 1, '主键必须触发一次动作');
  assert.equal(b.calls[0].fn, 'enhance', '首次点击 = 现有 enhance');
  assert.equal(b.calls[0].args[5], undefined, '首次不得走 fresh（第 6 参缺省）');
});

test('V42-02 双键状态机·result: 主=撤销优化（undo + titleResult）+ 副 ⟳（auxRedo）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-result';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿R' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTR' });
  h.api.enhance(sid, '草稿R', inputActions, draftRef);
  await flush();
  assert.equal(h.api.storeFor(sid).phase, 'result');
  const b = loadButtonSpy(h, sid);
  const el = b.render('OUTR', 'plain'); // 结果已写回草稿 → 未改态（D === L）
  const main = mainBtnOf(el);
  assert.equal(collectText(main).join(''), 'result', '§3.2：result 态主键文案 = t(result)（撤销优化）');
  assert.equal(main.props.title, 'titleResult');
  assert.equal(main.props.disabled, false, '撤销态恒可点（disabled=false）');
  assert.ok(hasClass(main, 'dsh-enh-btn-result'), '撤销态必须带 dsh-enh-btn-result');
  const aux = auxBtnOf(el);
  assert.ok(aux, '§3.2：optimized && phase=result 必须渲染副键');
  assert.equal(aux.type, 'button');
  assert.equal(aux.props.tabIndex, -1, '副键不可 Tab 聚焦');
  assert.equal(aux.props.title, 'auxRedo');
  assert.equal(aux.props['aria-label'], 'auxRedo');
  assert.equal(auxGlyphOf(el), '⟳', '未改态副键字形 = ⟳（从零重新优化）');
  main.props.onClick();
  await flush();
  assert.equal(b.calls[0].fn, 'undo', '§3.2：result / idle 未改共用「撤销优化」产物 → 主键 = undo');
  assert.equal(h.api.storeFor(sid).phase, 'idle');
  assert.equal(h.api.storeFor(sid).optimized, false, '链空 → 回首次态');
});

test('V42-03 双键状态机·未改 idle: 与 result 共用撤销产物；副键 ⟳ 点击 = fresh（第 6 参 true，不带 memory/answers）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-idle';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿I' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTI' });
  h.api.enhance(sid, '草稿I', inputActions, draftRef);
  await flush();
  const s = h.api.storeFor(sid);
  s.phase = 'idle'; // 结果已被消费（撤销入口脱离 result 态）
  const b = loadButtonSpy(h, sid);
  const el = b.render('OUTI', 'plain');
  const main = mainBtnOf(el);
  assert.equal(collectText(main).join(''), 'result', '§3.2：idle + 草稿正文 === 末轮 output → 同一撤销产物');
  assert.equal(main.props.title, 'titleResult');
  assert.equal(main.props.disabled, false);
  assert.ok(hasClass(main, 'dsh-enh-btn-result'), '撤销态类名与 result 态一致');
  const aux = auxBtnOf(el);
  assert.equal(auxGlyphOf(el), '⟳');
  assert.equal(aux.props.title, 'auxRedo');
  aux.props.onClick();
  await flush();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].fn, 'enhance', '未改态副键 = 从零单次（fresh）');
  assert.equal(b.calls[0].args[5], true, '§3.2：副键 fresh 必须显式传第 6 参 true');
  const sent = lastEnhanceArgs(h);
  assert.equal(sent.memory, undefined, '§3.1-1：fresh 请求不得携带 memory');
  assert.equal(sent.answers, undefined, '§3.1-1：fresh 请求不得携带 answers');
});

test('V42-04 双键状态机·已改 + 记忆开: 主=继续优化（普通 enhance）+ 副 ↺（undo）；改回原样/斜杠前缀 → 回撤销+⟳', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-cont';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿C' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTC' });
  h.api.enhance(sid, '草稿C', inputActions, draftRef);
  await flush();
  h.api.storeFor(sid).phase = 'idle';
  const b = loadButtonSpy(h, sid);
  // 已修改（记忆开 → 继续优化）
  let el = b.render('OUTC 改', 'plain');
  let main = mainBtnOf(el);
  assert.equal(collectText(main).join(''), 'btnContinue', '§3.2：已改 + 记忆开 → 继续优化');
  assert.equal(main.props.title, 'titleContinue');
  assert.equal(main.props.disabled, false);
  assert.equal(hasClass(main, 'dsh-enh-btn-result'), false, '继续优化不得带撤销态类名');
  assert.equal(auxGlyphOf(el), '↩', '已改态副键字形 = ↩（回勾箭头）');
  assert.equal(auxBtnOf(el).props.title, 'auxUndo');
  assert.equal(auxBtnOf(el).props['aria-label'], 'auxUndo');
  // 改回原样（逐字节一致）→ 回撤销 + ⟳
  el = b.render('OUTC', 'plain');
  main = mainBtnOf(el);
  assert.equal(collectText(main).join(''), 'result', '§5.1：改回原样 → 回「撤销优化」');
  assert.equal(main.props.title, 'titleResult');
  assert.equal(auxGlyphOf(el), '⟳', '副键字形随判定回到 ⟳');
  // 斜杠命令：前缀剥离后对比（/deploy OUTC ≡ OUTC）
  el = b.render('/deploy OUTC', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'result', '斜杠命令按正文对比（前缀不参与判定）');
  assert.equal(auxGlyphOf(el), '⟳');
  // 副键 ↩（回勾箭头）= undo（不带 fresh）
  el = b.render('OUTC 改', 'plain');
  auxBtnOf(el).props.onClick();
  await flush();
  assert.equal(b.calls[0].fn, 'undo', '§3.2：已改态副键 = undo');
  assert.equal(h.api.storeFor(sid).optimized, false, '链空 → 回首次态');
  // 主键 = 普通 enhance（继续优化；携带链，第 6 参缺省）
  const sid2 = 'sess-v42-cont2';
  const dr2 = { current: 'c2' };
  h.api.enhance(sid2, 'c2', inputActions, dr2);
  await flush();
  h.api.storeFor(sid2).phase = 'idle';
  const b2 = loadButtonSpy(h, sid2);
  const el2 = b2.render('OUTC 改', 'plain');
  assert.equal(collectText(mainBtnOf(el2)).join(''), 'btnContinue');
  mainBtnOf(el2).props.onClick();
  await flush();
  assert.equal(b2.calls[0].fn, 'enhance', '§3.2：已改 + 记忆开主键 = 普通 enhance');
  assert.equal(b2.calls[0].args[5], undefined, '主键普通路径不得传 fresh');
  const sent2 = lastEnhanceArgs(h);
  assert.ok(sent2.memory && Array.isArray(sent2.memory.rounds) && sent2.memory.rounds.length >= 1,
    '普通 enhance 必须携带记忆链（继续优化语义）');
});

test('V42-05 双键状态机·已改 + 记忆关: 主=重新优化（fresh，第 6 参 true）+ 副 ↺（undo）', async () => {
  const h = loadHelpers({ memory: false, mode: 'standard' });
  const sid = 'sess-v42-redo';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: 'c3' };
  h.hostStub.respond = () => ({ ok: true, text: 'O3' });
  h.api.enhance(sid, 'c3', inputActions, draftRef);
  await flush();
  const s = h.api.storeFor(sid);
  assert.deepEqual(s.memoryRounds, [], '记忆关 → 无链（基准回退 s.enhanced 剥前缀）');
  assert.equal(s.enhanced, 'O3');
  s.phase = 'idle';
  const b = loadButtonSpy(h, sid);
  let el = b.render('O3 改', 'plain');
  const main = mainBtnOf(el);
  assert.equal(collectText(main).join(''), 'btnRedo', '§3.2：已改 + 记忆关 → 重新优化');
  assert.equal(main.props.title, 'titleRedo');
  assert.equal(main.props.disabled, false);
  assert.equal(hasClass(main, 'dsh-enh-btn-result'), false, '重新优化不是撤销态');
  assert.equal(auxGlyphOf(el), '↩');
  assert.equal(auxBtnOf(el).props.title, 'auxUndo');
  // 副键 ↩（回勾箭头）= undo
  auxBtnOf(el).props.onClick();
  await flush();
  assert.equal(b.calls[0].fn, 'undo', '§3.2：已改态副键 = undo（记忆关亦然）');
  // 恢复未消费态，再验主键 = fresh
  s.phase = 'idle';
  s.optimized = true;
  s.enhanced = 'O3';
  s.backup = 'c3';
  s.memoryRounds = [];
  el = b.render('O3 改', 'plain');
  mainBtnOf(el).props.onClick();
  await flush();
  const freshCall = b.calls.filter((c) => c.fn === 'enhance')[0];
  assert.ok(freshCall, '主键必须触发 enhance');
  assert.equal(freshCall.args[5], true, '§3.2：记忆关已改主键 = fresh（天然从零）');
  const sent = lastEnhanceArgs(h);
  assert.equal(sent.memory, undefined, '§3.1-1：fresh 请求不带 memory');
  assert.equal(sent.answers, undefined, '§3.1-1：fresh 请求不带 answers');
});

test('V42-06 双键状态机·改回原样: 修改 → 继续优化（↺）；逐字节还原 → 撤销优化（⟳ 复活，点击 = fresh）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-back';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: 'c6' };
  h.hostStub.respond = () => ({ ok: true, text: 'O6' });
  h.api.enhance(sid, 'c6', inputActions, draftRef);
  await flush();
  h.api.storeFor(sid).phase = 'idle';
  const b = loadButtonSpy(h, sid);
  let el = b.render('O6 改', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'btnContinue');
  assert.equal(auxGlyphOf(el), '↩');
  el = b.render('O6 改后还原但仍不同', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'btnContinue', '仍不相等 → 继续优化');
  el = b.render('O6', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'result', '§5.1：改回原样 → 回撤销优化');
  assert.equal(auxGlyphOf(el), '⟳', '副键字形随判定回 ⟳');
  assert.equal(auxBtnOf(el).props.title, 'auxRedo');
  auxBtnOf(el).props.onClick();
  await flush();
  assert.equal(b.calls[0].fn, 'enhance', '还原后副键 = fresh');
  assert.equal(b.calls[0].args[5], true);
});

test('V42-07 双键状态机·保底与隐藏: L === null 按「已改」处理；enhancing / clarify 态不渲染副键', () => {
  const run = (mode, memory) => {
    const h = loadHelpers({ memory, mode });
    const sid = 'sess-v42-fallback-' + mode + '-' + String(memory);
    const s = h.api.storeFor(sid);
    s.phase = 'idle';
    s.optimized = true;
    s.memoryRounds = []; // 无链
    s.enhanced = '';     // 且无最近结果 → lastOutput === null（§一 保底）
    const b = loadButtonSpy(h, sid);
    return b.render('任意草稿', 'plain');
  };
  // 记忆开：按「已改」→ 主键继续优化 + 副键 ↺
  let el = run('standard', true);
  assert.equal(collectText(mainBtnOf(el)).join(''), 'btnContinue', '§一：L === null 按「已改」处理（保底，实际不可达）');
  assert.equal(auxGlyphOf(el), '↩', '已改 → 副键 ↩（回勾箭头）');
  // 记忆关：按「已改」→ 主键重新优化 + 副键 ↺
  el = run('standard', false);
  assert.equal(collectText(mainBtnOf(el)).join(''), 'btnRedo', 'L === null + 记忆关 → 重新优化（fresh）');
  assert.equal(auxGlyphOf(el), '↩');
  // enhancing 态（optimized 仍为 true，如从零重跑在途）：副键必须隐藏，主键 = 既有 busy 产物
  const h3 = loadHelpers({ memory: true, mode: 'standard' });
  const sid3 = 'sess-v42-busy';
  const s3 = h3.api.storeFor(sid3);
  s3.phase = 'enhancing';
  s3.optimized = true;
  s3.memoryRounds = [{ input: 'a', output: 'A' }];
  const b3 = loadButtonSpy(h3, sid3);
  const busy = b3.render('a', 'plain');
  assert.equal(auxBtnOf(busy), undefined, '§3.2：enhancing 态不得渲染副键');
  assert.ok(hasClass(mainBtnOf(busy), 'dsh-enh-btn-busy'), 'enhancing 主键仍是既有 busy 产物');
  assert.equal(mainBtnOf(busy).props.title, 'titleBusy');
  // clarify 态（optimized 仍为 true）：副键必须隐藏，主键 = 既有 clarify 产物
  const h4 = loadHelpers({ memory: true, mode: 'expert' });
  const sid4 = 'sess-v42-clarifyhide';
  const s4 = h4.api.storeFor(sid4);
  s4.phase = 'clarify';
  s4.optimized = true;
  s4.clarify = [{ q: 'Q1', options: ['a', 'b'] }];
  const b4 = loadButtonSpy(h4, sid4);
  const clarifyEl = b4.render('草稿', 'plain');
  assert.equal(auxBtnOf(clarifyEl), undefined, '§3.2：clarify 态不得渲染副键');
  assert.ok(hasClass(mainBtnOf(clarifyEl), 'dsh-enh-btn-clarify'), 'clarify 主键仍是既有 clarify 产物');
  assert.equal(mainBtnOf(clarifyEl).props.title, 'titleClarify');
});

test('V42-10 无链回退（重写 V4·无链）: 记忆关 lite/standard 链空但 s.enhanced 在 → 基准 = 最近结果正文（含剥前缀）', async () => {
  for (const mode of ['standard', 'lite']) {
    const h = loadHelpers({ memory: false, mode });
    const sid = 'sess-v42-nolink-' + mode;
    const inputActions = { setDraft: () => {} };
    const draftRef = { current: '/go 草稿N' };
    h.hostStub.respond = () => ({ ok: true, text: 'OUT2' });
    h.api.enhance(sid, '/go 草稿N', inputActions, draftRef);
    await flush();
    const s = h.api.storeFor(sid);
    assert.deepEqual(s.memoryRounds, [], mode + '：记忆关 → 不写链');
    assert.equal(s.enhanced, '/go OUT2', mode + '：结果含命令前缀写回');
    s.phase = 'idle';
    const b = loadButtonSpy(h, sid);
    let el = b.render('/go OUT2', 'plain');
    assert.equal(collectText(mainBtnOf(el)).join(''), 'result', mode + '：无链基准 = s.enhanced 剥前缀 → 未改 → 撤销优化');
    assert.equal(auxGlyphOf(el), '⟳');
    el = b.render('/go OUT2 改', 'plain');
    assert.equal(collectText(mainBtnOf(el)).join(''), 'btnRedo', mode + '：无链 + 已改 + 记忆关 → 重新优化');
    assert.equal(auxGlyphOf(el), '↩', mode + '：已改 → 副键 ↩');
  }
});

// ================= v4.2-r2（task-4·§1.1 修订）：独立验证 D-1/D-2 反例 + 覆盖矩阵 =================
test('V42-33 重新优化载荷牙齿: 记忆关 + 预置全局澄清记录 + 已改 ⇒ fresh 请求不带 answers / memory', async () => {
  const h = loadHelpers({ memory: false, mode: 'standard' });
  const sid = 'sess-v42-redo-payload';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: 'c5' };
  const prior = [{ q: 'Q1', a: 'a', via: 'option' }];
  h.lsBacking.set(CK(sid), JSON.stringify(prior)); // 全局已入库澄清记录（记忆关不影响它）
  const s = h.api.storeFor(sid);
  assert.deepEqual(s.clarifyAnswers, prior, '前置：全局澄清记录在 store 中');
  h.hostStub.respond = () => ({ ok: true, text: 'O5' });
  h.api.enhance(sid, 'c5', inputActions, draftRef);
  await flush();
  // 反证（牙齿）：同一 store 上的**非 fresh**请求确实会带上这份全局记录
  assert.deepEqual(sentEnhances(h)[0].args.answers, prior, '反证：非 fresh 路径会携带全局旧澄清记录（故下面的 undefined 非空断言）');
  assert.deepEqual(s.memoryRounds, [], '记忆关 → 无链');
  s.phase = 'idle';
  const b = loadButtonSpy(h, sid);
  const el = b.render('O5 改', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'btnRedo', '前置：主键 = 重新优化（记忆关 + 已改）');
  mainBtnOf(el).props.onClick();
  await flush();
  const sent = lastEnhanceArgs(h);
  assert.equal(sent.answers, undefined, '★ 载荷牙齿：主键入口少传第 6 参时会静默带上全局旧澄清记录（必须 undefined）');
  assert.equal(sent.memory, undefined, '★ 载荷牙齿：fresh 请求不得携带 memory');
  assert.equal(b.calls[0].args[5], true, '第 6 参确为 fresh（行为与载荷双断言）');
});

test('V42-34 r2 反例 D-1·混合态: 链尾早于最近结果 ⇒ 主=撤销 + 副=⟳；undo 回 backup 且不 pop 链', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-mixed';
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: 'A', output: 'O1' }]; // 旧轮（早于最近一次结果）
  s.enhanced = 'O2';                               // 最近结果（链尾 ≠ 最近结果 ⇒ 混合态）
  s.backup = 'B';
  s.phase = 'result';
  s.optimized = true;
  h.api.saveMemoryStore(sid, s.memoryRounds);
  const writes = [];
  const b = loadButtonSpy(h, sid, { inputActions: { setDraft: (v) => writes.push(v) } });
  const el = b.render('O2', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'result', '§1.1①：L = 最近结果 → 草稿未改 ⇒ 撤销优化（旧「链优先」口径会误判已改）');
  assert.equal(mainBtnOf(el).props.title, 'titleResult');
  assert.ok(auxBtnOf(el), '副键必须渲染');
  assert.equal(auxGlyphOf(el), '⟳', '§1.1①/②：副键 ⟳（与主键 undo 同源；旧口径落 ↺ ⇒ 双 undo 窗口）');
  assert.equal(auxBtnOf(el).props.title, 'auxRedo');
  mainBtnOf(el).props.onClick();
  assert.deepEqual(writes, ['B'], '§1.1③：live 非空 ⇒ 回退取 backup = B（不是链末 input A）');
  assert.deepEqual(s.memoryRounds, [{ input: 'A', output: 'O1' }], '§1.1③：链末轮不属本轮（backup 正文 ≠ 链末 input）⇒ 不 pop');
  assert.equal(s.optimized, true, '链非空 ⇒ optimized 保持 true（该行仍是可撤销态）');
  assert.equal(s.phase, 'idle');
  assert.equal(s.enhanced, '');
  assert.deepEqual(JSON.parse(h.lsBacking.get(MK(sid))), [{ input: 'A', output: 'O1' }], '不 pop ⇒ 持久化键原样不动');
  // 混合态 + phase='idle'（结果已被消费）：同「未改」行 —— 主=撤销 + 副 ⟳（旧实现会给 btnContinue + ↺）
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-v42-mixed-idle';
  const s2 = h2.api.storeFor(sid2);
  s2.memoryRounds = [{ input: 'A', output: 'O1' }];
  s2.enhanced = 'O2';
  s2.backup = 'B';
  s2.phase = 'idle';
  s2.optimized = true;
  const b2 = loadButtonSpy(h2, sid2);
  const el2 = b2.render('O2', 'plain');
  assert.equal(collectText(mainBtnOf(el2)).join(''), 'result', '§1.1①：混合态 + idle + 草稿未改 ⇒ 仍是撤销优化行');
  assert.equal(mainBtnOf(el2).props.title, 'titleResult');
  assert.equal(auxGlyphOf(el2), '⟳', '§1.1①/②：混合态 idle 的副键同样是 ⟳');
  assert.equal(auxBtnOf(el2).props.title, 'auxRedo');
  // 混合态下副键 ⟳ 仍是从零入口：6 参 + 载荷无 memory/answers
  h2.hostStub.respond = () => ({ ok: true, text: 'O2F' });
  auxBtnOf(el2).props.onClick();
  await flush();
  assert.equal(b2.calls[0].fn, 'enhance', '混合态副键 = fresh（从零单次）');
  assert.equal(b2.calls[0].args[5], true, '§3.2：第 6 参 true');
  const sent = lastEnhanceArgs(h2);
  assert.equal(sent.memory, undefined, '§3.1-1：混合态 ⟳ 同样不带 memory');
  assert.equal(sent.answers, undefined, '§3.1-1：混合态 ⟳ 同样不带 answers');
});

test('V42-35 r2 反例 D-2: 模型输出自带 /cmd 前缀 ⇒ 草稿未改仍判「撤销优化 + ⟳」', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-d2';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿D2' };
  h.hostStub.respond = () => ({ ok: true, text: '/deploy OUT2' }); // 模型输出自身以 /deploy 开头
  h.api.enhance(sid, '草稿D2', inputActions, draftRef);
  await flush();
  const s = h.api.storeFor(sid);
  assert.equal(s.enhanced, '/deploy OUT2', '草稿无命令前缀 ⇒ 结果逐字写回');
  assert.deepEqual(s.memoryRounds, [{ input: '草稿D2', output: '/deploy OUT2' }], '链末 output 同样以 /deploy 开头（D-2 前提）');
  s.phase = 'idle';
  const b = loadButtonSpy(h, sid);
  const el = b.render('/deploy OUT2', 'plain');
  assert.equal(collectText(mainBtnOf(el)).join(''), 'result', '§1.1①：L = draftBodyOf(s.enhanced) = OUT2 = D ⇒ 未改（旧「链优先」口径误判已改）');
  assert.equal(auxGlyphOf(el), '⟳', '§1.1①：副键 ⟳');
  assert.equal(auxBtnOf(el).props.title, 'auxRedo');
});

test('V42-36 r2 undo 覆盖矩阵: 七格逐格断言草稿写入值 + 链变化 + optimized + 持久化键', () => {
  const seed = (opts) => {
    const h = loadHelpers({ memory: opts.memory, mode: 'standard' });
    const sid = opts.sid;
    const s = h.api.storeFor(sid);
    s.phase = opts.phase;
    s.optimized = opts.optimized;
    s.backup = opts.backup;
    s.enhanced = opts.enhanced;
    s.memoryRounds = opts.rounds.map((x) => ({ input: x[0], output: x[1] }));
    if (s.memoryRounds.length > 0) h.api.saveMemoryStore(sid, s.memoryRounds);
    const writes = [];
    h.api.undo(sid, { setDraft: (v) => writes.push(v) });
    const mk = h.lsBacking.has(MK(sid)) ? JSON.parse(h.lsBacking.get(MK(sid))) : null;
    return { h, s, writes, mk };
  };
  // ① result·记忆开：live 非空 + backup 与链末 input 同源 ⇒ 回退 backup + pop
  let r = seed({ sid: 'undo-m1', memory: true, phase: 'result', optimized: true, backup: 'd1', enhanced: 'O1', rounds: [['d1', 'O1']] });
  assert.deepEqual(r.writes, ['d1'], '① 回退取 backup');
  assert.deepEqual(r.s.memoryRounds, [], '① pop 一轮');
  assert.equal(r.s.optimized, false, '① 链空 ⇒ 回首次态');
  assert.equal(r.h.lsBacking.has(MK('undo-m1')), false, '① pop 后空链即删键');
  assert.equal(r.s.phase, 'idle', '① 一律落 idle');
  assert.equal(r.s.enhanced, '', '① 清最近结果');
  // ② result·记忆关：无链 ⇒ 回退 backup、不 pop、optimized=false
  r = seed({ sid: 'undo-m2', memory: false, phase: 'result', optimized: true, backup: 'd2', enhanced: 'O2', rounds: [] });
  assert.deepEqual(r.writes, ['d2'], '② 无链 ⇒ 只有一个回退点 backup');
  assert.deepEqual(r.s.memoryRounds, []);
  assert.equal(r.s.optimized, false, '② 链空 ⇒ 回首次态');
  assert.equal(r.mk, null, '② 无链无键');
  // ③ idle 已改：结果仍在（live）⇒ 放开撤销、回退 backup + pop
  r = seed({ sid: 'undo-m3', memory: true, phase: 'idle', optimized: true, backup: 'c', enhanced: 'O', rounds: [['c', 'O']] });
  assert.deepEqual(r.writes, ['c'], '③ idle + optimized ⇒ 放开撤销（§3.1 前置）');
  assert.deepEqual(r.s.memoryRounds, []);
  assert.equal(r.s.optimized, false);
  // ④ 3 轮连环撤销：每步回该轮起点；前两步链非空保持 optimized=true，第三步链空复位
  const h4 = loadHelpers({ memory: true, mode: 'standard' });
  const s4 = h4.api.storeFor('undo-m4');
  s4.phase = 'result';
  s4.optimized = true;
  s4.backup = 'd3';
  s4.enhanced = 'O3';
  s4.memoryRounds = [['d1', 'O1'], ['d2', 'O2'], ['d3', 'O3']].map((x) => ({ input: x[0], output: x[1] }));
  h4.api.saveMemoryStore('undo-m4', s4.memoryRounds);
  const w4 = [];
  const ia4 = { setDraft: (v) => w4.push(v) };
  h4.api.undo('undo-m4', ia4);
  assert.deepEqual(w4, ['d3'], '④-1 live ⇒ 回 backup（= 末轮起点）');
  assert.equal(s4.memoryRounds.length, 2);
  assert.equal(s4.optimized, true, '④-1 链非空 ⇒ 仍可继续撤销');
  h4.api.undo('undo-m4', ia4);
  assert.deepEqual(w4, ['d3', 'd2'], '④-2 live 已清 ⇒ 回末轮 input');
  assert.equal(s4.memoryRounds.length, 1);
  assert.equal(s4.optimized, true);
  h4.api.undo('undo-m4', ia4);
  assert.deepEqual(w4, ['d3', 'd2', 'd1'], '④-3 逐轮回退');
  assert.deepEqual(s4.memoryRounds, []);
  assert.equal(s4.optimized, false, '④-3 撤到链空 ⇒ 回首次态');
  assert.equal(h4.lsBacking.has(MK('undo-m4')), false, '④-3 空链即删键');
  // ⑤ 刷新兜底：backup 与 live 均空 + 链非空 ⇒ 回末轮 input + pop
  r = seed({ sid: 'undo-m5', memory: true, phase: 'idle', optimized: true, backup: '', enhanced: '', rounds: [['r1', 'R1'], ['r2', 'R2']] });
  assert.deepEqual(r.writes, ['r2'], '⑤ backup 空 ⇒ 回退末轮 input');
  assert.deepEqual(r.s.memoryRounds, [{ input: 'r1', output: 'R1' }]);
  assert.equal(r.s.optimized, true, '⑤ 链非空 ⇒ 保持可撤销');
  assert.deepEqual(r.mk, [{ input: 'r1', output: 'R1' }], '⑤ pop 即同步持久化键');
  // ⑥ 混合态（链尾 ≠ 最近结果）：回退 backup、不 pop、optimized 保持
  r = seed({ sid: 'undo-m6', memory: true, phase: 'result', optimized: true, backup: 'B', enhanced: 'O2', rounds: [['A', 'O1']] });
  assert.deepEqual(r.writes, ['B'], '⑥ 混合态回退 backup（不是链末 input A）');
  assert.deepEqual(r.s.memoryRounds, [{ input: 'A', output: 'O1' }], '⑥ 不 pop（链末轮不属本轮）');
  assert.equal(r.s.optimized, true, '⑥ 链非空 ⇒ 保持 true');
  assert.deepEqual(r.mk, [{ input: 'A', output: 'O1' }], '⑥ 不 pop ⇒ 持久化键不动');
  // ⑦ 空链 + 空 backup + 空 live：零副作用（不写空草稿、不动状态）
  r = seed({ sid: 'undo-m7', memory: true, phase: 'idle', optimized: true, backup: '', enhanced: '', rounds: [] });
  assert.deepEqual(r.writes, [], '⑦ restore === "" ⇒ 不动作');
  assert.equal(r.s.phase, 'idle');
  assert.equal(r.s.optimized, true);
  assert.deepEqual(r.s.memoryRounds, []);
  // ⑦b result 态但 backup 空、live 非空、无链 ⇒ restore 仍为空 ⇒ 零副作用
  r = seed({ sid: 'undo-m7b', memory: false, phase: 'result', optimized: true, backup: '', enhanced: 'O', rounds: [] });
  assert.deepEqual(r.writes, [], '⑦b live 非空但 backup 空且无链 ⇒ restore 空 ⇒ 不动作');
  assert.equal(r.s.phase, 'result', '⑦b 不动作 ⇒ 状态原样');
  assert.equal(r.s.optimized, true);
});

test('V42-37 判据同源（r3 逐态绝对期望）: 主键产物 + 副键字形；result 且 D ≠ L 仍须是可点的撤销优化', () => {
  // v4.2-r3（§1.1② 订正）：逐态**绝对期望**（title / 字形 / disabled）——旧版「相对断言」
  //（mainIsUndo === auxIsRedo）对变异 m8（isUndoState 删掉 phase === 'result' 析取项）无牙：
  // 它把主副键「一起」判错，相对关系仍成立。析取项是承重结构 ⇒ 必须逐态钉死。
  const cases = [
    { name: 'result-记忆开', memory: true, phase: 'result', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: 'O', title: 'titleResult', glyph: '⟳' },
    { name: 'result-记忆关', memory: false, phase: 'result', backup: 'd', enhanced: 'O', rounds: [], draft: 'O', title: 'titleResult', glyph: '⟳' },
    // m8 三格（result 态而 D ≠ L：草稿未回灌 / 编辑中一帧 / 回灌草稿 === backup）——
    // isUntouched=false 但 phase 承重 ⇒ 主键仍须是**可点的**「撤销优化」（titleResult + disabled=false）
    { name: 'result-草稿未回灌', memory: true, phase: 'result', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: '', title: 'titleResult', glyph: '⟳', disabled: false },
    { name: 'result-编辑中一帧', memory: true, phase: 'result', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: 'O 改', title: 'titleResult', glyph: '⟳', disabled: false },
    { name: 'result-回灌草稿等于backup', memory: true, phase: 'result', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: 'd', title: 'titleResult', glyph: '⟳', disabled: false },
    { name: '混合态', memory: true, phase: 'result', backup: 'B', enhanced: 'O2', rounds: [['A', 'O1']], draft: 'O2', title: 'titleResult', glyph: '⟳' },
    { name: '混合态-idle', memory: true, phase: 'idle', backup: 'B', enhanced: 'O2', rounds: [['A', 'O1']], draft: 'O2', title: 'titleResult', glyph: '⟳' },
    { name: 'idle-未改-记忆开', memory: true, phase: 'idle', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: 'O', title: 'titleResult', glyph: '⟳' },
    { name: 'D-2-输出自带命令前缀', memory: true, phase: 'idle', backup: 'c', enhanced: '/deploy O', rounds: [['c', '/deploy O']], draft: '/deploy O', title: 'titleResult', glyph: '⟳' },
    // §1.1① 回退分支：enhanced === '' + 链非空 ⇒ L 取链末 output（草稿 = 该 output ⇒ 未改）
    { name: '回退分支-链非空-enhanced空', memory: true, phase: 'idle', backup: '', enhanced: '', rounds: [['d', 'O']], draft: 'O', title: 'titleResult', glyph: '⟳' },
    { name: 'idle-已改-记忆开', memory: true, phase: 'idle', backup: 'd', enhanced: 'O', rounds: [['d', 'O']], draft: 'O 改', title: 'titleContinue', glyph: '↩' },
    { name: 'idle-已改-记忆关', memory: false, phase: 'idle', backup: 'd', enhanced: 'O', rounds: [], draft: 'O 改', title: 'titleRedo', glyph: '↩' },
  ];
  for (const c of cases) {
    const h = loadHelpers({ memory: c.memory, mode: 'standard' });
    const sid = 'sess-v42-inv-' + c.name;
    const s = h.api.storeFor(sid);
    s.phase = c.phase;
    s.optimized = true;
    s.backup = c.backup;
    s.enhanced = c.enhanced;
    s.memoryRounds = c.rounds.map((x) => ({ input: x[0], output: x[1] }));
    const b = loadButtonSpy(h, sid);
    const el = b.render(c.draft, 'plain');
    const aux = auxBtnOf(el);
    assert.ok(aux, c.name + '：optimized + result/idle 必须渲染副键');
    const main = mainBtnOf(el);
    assert.equal(main.props.title, c.title, c.name + '：§1.1② 主键产物（逐态绝对期望；m8 变异在此变红）');
    assert.equal(auxGlyphOf(el), c.glyph, c.name + '：§1.1② 副键字形必须与主键同源（不得「主=撤销 且 副=↺」）');
    assert.equal(aux.props.title, c.glyph === '⟳' ? 'auxRedo' : 'auxUndo', c.name + '：副键 title/aria 与字形一致');
    if (c.disabled !== undefined) {
      assert.equal(main.props.disabled, c.disabled, c.name + '：撤销优化键必须可点（m8 下退化为 disabled 的继续优化）');
    }
    if (c.title === 'titleResult') {
      assert.equal(collectText(main).join(''), 'result', c.name + '：撤销文案 = t(result)');
      assert.ok(hasClass(main, 'dsh-enh-btn-result'), c.name + '：撤销态类名 dsh-enh-btn-result');
    }
  }
});

test('V42-38 r3 反例 S20·pop 身份判据: 文本巧合不得误弹链；链末确属本轮才 pop', async () => {
  // ① S20：记忆开 X→O1 ⇒ 关记忆流（不清链，D-1 前提）⇒ 草稿改回逐字相同的 X ⇒ fresh 得 O2
  //（backup=X，与链末 input 文本巧合）⇒ 点主键撤销：live(O2) 与链末 output(O1) 不对齐 ⇒ **不得 pop**
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-s20';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: 'X' };
  let n = 0;
  h.hostStub.respond = () => ({ ok: true, text: 'O' + (++n) });
  h.api.enhance(sid, 'X', inputActions, draftRef); // 记忆开：链 [X→O1]
  await flush();
  const s = h.api.storeFor(sid);
  assert.deepEqual(s.memoryRounds, [{ input: 'X', output: 'O1' }], '前置：链 [X→O1]');
  assert.equal(s.enhanced, 'O1');
  h.configState.value.memory = false; // 关记忆流（不清链 —— D-1 的既有口径）
  draftRef.current = 'X';
  h.api.enhance(sid, 'X', inputActions, draftRef, undefined, true); // 从零重跑（记忆关 + 已改 ⇒ 主键「重新优化」）
  await flush();
  assert.equal(s.enhanced, 'O2', '前置：最近结果 O2（与链末 output O1 不同）');
  assert.equal(s.backup, 'X', '前置：backup = X（与链末 input 文本巧合 —— S20 的触发条件）');
  assert.deepEqual(s.memoryRounds, [{ input: 'X', output: 'O1' }], '记忆关轮次不入链 ⇒ 链仍是 [X→O1]');
  s.phase = 'result';
  const writes = [];
  const b = loadButtonSpy(h, sid, { inputActions: { setDraft: (v) => writes.push(v) } });
  const el = b.render('O2', 'plain'); // 结果写回草稿 ⇒ 未改（L = draftBodyOf(s.enhanced) = O2）
  assert.equal(collectText(mainBtnOf(el)).join(''), 'result', '前置：主键 = 撤销优化');
  assert.equal(auxGlyphOf(el), '⟳');
  mainBtnOf(el).props.onClick();
  assert.deepEqual(writes, ['X'], '① 回退值 = backup（X，与链末 input 同文本）');
  assert.deepEqual(s.memoryRounds, [{ input: 'X', output: 'O1' }], '§1.1③-b：live(O2) 与链末 output(O1) 不对齐 ⇒ 不得误弹（旧 backup 文本相似性代理会弹）');
  assert.equal(s.optimized, true, '① 不 pop ⇒ optimized 保持 true（链仍有效）');
  assert.deepEqual(JSON.parse(h.lsBacking.get(MK(sid))), [{ input: 'X', output: 'O1' }], '① 不 pop ⇒ 持久化链键不变');
  assert.equal(s.phase, 'idle');
  // ② 对照格（backup=Y，文本不巧合）：同样不 pop —— 与 ① 行为一致 ⇒ 判据不再由文本巧合决定
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-v42-s20-ctl';
  const s2 = h2.api.storeFor(sid2);
  s2.memoryRounds = [{ input: 'X', output: 'O1' }];
  s2.enhanced = 'O2';
  s2.backup = 'Y';
  s2.phase = 'result';
  s2.optimized = true;
  h2.api.saveMemoryStore(sid2, s2.memoryRounds);
  const w2 = [];
  h2.api.undo(sid2, { setDraft: (v) => w2.push(v) });
  assert.deepEqual(w2, ['Y'], '② 对照格：回退 backup Y');
  assert.deepEqual(s2.memoryRounds, [{ input: 'X', output: 'O1' }], '② 对照格：同样不 pop');
  assert.equal(s2.optimized, true);
  assert.deepEqual(JSON.parse(h2.lsBacking.get(MK(sid2))), [{ input: 'X', output: 'O1' }], '② 对照格：持久化链键不变');
  // ③ 防回归：链末确属本轮（live === 链末 output）⇒ 仍 pop + 空链删键
  const h3 = loadHelpers({ memory: true, mode: 'standard' });
  const sid3 = 'sess-v42-pop-normal';
  const s3 = h3.api.storeFor(sid3);
  s3.memoryRounds = [{ input: 'd', output: 'O' }];
  s3.enhanced = 'O';
  s3.backup = 'd';
  s3.phase = 'result';
  s3.optimized = true;
  h3.api.saveMemoryStore(sid3, s3.memoryRounds);
  const w3 = [];
  h3.api.undo(sid3, { setDraft: (v) => w3.push(v) });
  assert.deepEqual(w3, ['d'], '③ 正常记忆开 result：回退 backup');
  assert.deepEqual(s3.memoryRounds, [], '③ live === 链末 output ⇒ 仍 pop（防回归：判据收紧不得吞掉正常弹链）');
  assert.equal(s3.optimized, false, '③ 链空 ⇒ 回首次态');
  assert.equal(h3.lsBacking.has(MK(sid3)), false, '③ pop 后空链即删键');
  // ③b D-2 形态（两侧各剥一次前缀后对齐）：live='/deploy O' + 链末 output='O' ⇒ 仍 pop
  const h4 = loadHelpers({ memory: true, mode: 'standard' });
  const sid4 = 'sess-v42-pop-slash';
  const s4 = h4.api.storeFor(sid4);
  s4.memoryRounds = [{ input: 'd', output: 'O' }];
  s4.enhanced = '/deploy O';
  s4.backup = '/deploy d';
  s4.phase = 'result';
  s4.optimized = true;
  h4.api.saveMemoryStore(sid4, s4.memoryRounds);
  const w4 = [];
  h4.api.undo(sid4, { setDraft: (v) => w4.push(v) });
  assert.deepEqual(w4, ['/deploy d'], '③b 斜杠形态回退 backup（前缀保留）');
  assert.deepEqual(s4.memoryRounds, [], '③b splitCommand 两侧对齐 ⇒ pop（D-2 形态兼容）');
  assert.equal(h4.lsBacking.has(MK(sid4)), false, '③b pop 后删键');
});

test('V42-39 图标契约（v4.2.1 用户拍板）: 撤回 = 自绘回勾箭头 SVG（开口曲线）；重新 = 保持 ⟳ 字形', () => {
  // 用户反馈「两枚图标形态过于相似」→ 只改撤回侧（方案 D 的撤回几何）；重新侧按用户要求**保持不变**。
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-icons';
  const b = loadButtonSpy(h, sid);
  const s = h.api.storeFor(sid);
  s.optimized = true;
  s.phase = 'result';
  s.backup = 'd';
  s.enhanced = 'O';
  s.memoryRounds = [{ input: 'd', output: 'O' }];

  // ① 未改（撤销行）⇒ 副键 = 从零重新优化：保持 ⟳ 字形（零改动、零回归面）
  const redoBtn = auxBtnOf(b.render('O', 'plain'));
  assert.equal(redoBtn.props['data-glyph'], 'redo', 'data-glyph 语义钩子 = redo');
  const redoIcon = classEl(redoBtn, 'dsh-enh-aux-icon');
  assert.equal(collectEls(redoIcon, (x) => x.type === 'svg').length, 0, '重新侧不得改成 SVG（用户要求保持不变）');
  assert.equal(textOf(redoIcon), '⟳', '重新侧仍是 ⟳ 字形');

  // ② 已改 ⇒ 副键 = 撤回优化：内联 SVG 回勾箭头（官方规格：16×16 网格 / 1px 描边 / currentColor / round 端点）
  // 注意：§1.1② 的承重析取项使 result 态恒为「撤销行」（副键 = redo），故撤回态必须落在 idle（结果已被编辑消费）
  s.phase = 'idle';
  s.enhanced = '';
  const undoBtn = auxBtnOf(b.render('O 改', 'plain'));
  assert.equal(undoBtn.props['data-glyph'], 'undo', 'data-glyph 语义钩子 = undo');
  const undoIcon = classEl(undoBtn, 'dsh-enh-aux-icon');
  const svg = collectEls(undoIcon, (x) => x.type === 'svg')[0];
  assert.ok(svg, '撤回侧必须是内联 SVG（不再是字体字形）');
  assert.equal(svg.props.viewBox, '0 0 16 16', '与官方 DSH 图标同网格');
  assert.equal(svg.props.strokeWidth, 1, '1px 描边（官方规格）');
  assert.equal(svg.props.width, 14);
  assert.equal(svg.props.height, 14);
  assert.equal(textOf(undoIcon), '', '撤回侧不得再输出 ↺ 字形（否则与 ⟳ 又同属闭合圆环家族）');

  // ③ 几何逐字锁定：左向箭头 + 向右下弧尾
  const paths = collectEls(svg, (x) => x.type === 'path').map((p) => p.props.d);
  assert.deepEqual(paths, ['M5.6 4.4L2.4 7.6L5.6 10.8', 'M2.4 7.6H9.2C11.7 7.6 13.6 9.5 13.6 12'], '回勾箭头几何逐字锁定');
  assert.equal(paths.some((d) => /[Zz]/.test(d)), false, '回勾箭头必须是开口曲线（不得出现闭合子路径）');
  assert.ok(paths.every((d) => /^M/.test(d) && d.includes('stroke') === false), '两条子路径均自 M 起笔');

  // ④ 形态区分度（本用例的目的）：撤回 = 开口 SVG 曲线；重新 = 闭合圆环字形 ⇒ 结构层面不可混淆
  assert.equal(collectEls(undoIcon, (x) => x.type === 'svg').length, 1, '撤回侧恰一枚 SVG');
  assert.equal(collectEls(redoIcon, (x) => x.type === 'svg').length, 0, '重新侧零 SVG（保持字形）');
  assert.equal(auxGlyphOf(b.render('O', 'plain')), '⟳', '重新侧语义符号 = ⟳');
  assert.equal(auxGlyphOf(b.render('O 改', 'plain')), '↩', '撤回侧语义符号 = ↩（SVG 回勾箭头）');

  // ⑤ 样式接线：字形与 SVG 两种内容共存所需的规则必须在位
  const css = decodeChunk('src/client/styles.js');
  assert.ok(css.includes('.dsh-enh-aux .dsh-enh-aux-icon{display:inline-flex'), '容器须居中（字形 + SVG 两种内容）');
  assert.ok(css.includes('.dsh-enh-aux .dsh-enh-aux-icon svg{display:block;width:14px;height:14px}'), '缺副键 SVG 盒规则');
});

// ================= v4.2.2（副键布局预设 A + 继续优化蓝色态 + 重新优化中性底） =================
// 用户截图（图一 ⟳ / 图二 ↩，两态副键均处于悬停高亮）指出两处观感缺陷：
//   ① 「撤销优化 / 重新优化」两枚副键**选中范围不一致**（盒宽 20px vs 22px）、**居中对齐没做好**；
//   ② 「继续优化」与「撤销优化」形式不统一（一个裸文字、一个状态色胶囊）。
// 根因与修法见 styles.js v4.2.2 注释；本组把修法钉成契约（形态 + 接线 + 反例）。
const cssRuleOf = (css, sel) => {
  const i = css.indexOf(sel + '{');
  if (i < 0) return null;
  return css.slice(i + sel.length + 1, css.indexOf('}', i));
};

test('V422-01 副键选中范围契约: 盒宽与内容解耦（两态同一 28×28 盒）+ 与主键 2px 真实间隙', async () => {
  const css = decodeChunk('src/client/styles.js');
  const aux = cssRuleOf(css, '.dsh-enh-aux');
  assert.ok(aux, '缺 .dsh-enh-aux 规则');
  // ① 固定盒：width + min-width + height 三者齐备 ⇒ ⟳（字形 advance≈12px）与 ↩（14×14 SVG）不再改变盒宽
  assert.ok(/width:28px/.test(aux) && /min-width:28px/.test(aux) && /height:28px/.test(aux),
    '副键必须显式固定 28×28（width + min-width + height 三者齐备）');
  assert.ok(/(^|;)padding:0(;|$)/.test(aux), 'padding 必须归零——否则盒宽又随内容浮动');
  assert.equal(/min-width:20px/.test(aux), false, '旧的 min-width:20px（内容驱动盒宽）必须删除');
  // ② 间隙：旧的 -2px 让副键盒压进主键盒（两高亮区粘连）；改 +2px 真实间隙
  assert.ok(/margin-right:2px/.test(aux), '与主键盒之间必须是 +2px 真实间隙');
  assert.equal(/margin-right:-2px/.test(aux), false, '旧的 margin-right:-2px 重叠必须删除');
  // ③ 形状：固定盒取全圆角，并**显式退出**宿主全局 corner-shape（否则大圆角被超椭圆压成小圆角方块）
  assert.ok(/border-radius:999px/.test(aux), '固定盒取全圆角（圆形图标键）');
  assert.ok(/corner-shape:round/.test(aux), '必须显式声明 corner-shape:round（宿主全局为 superellipse(1.5)）');
  // ④ 图标盒恒定 16×16：⟳ 行盒与 ↩ SVG 共用同一光学盒 ⇒ 两态图标在圆内居中位置一致
  const icon = cssRuleOf(css, '.dsh-enh-aux .dsh-enh-aux-icon');
  assert.ok(icon && /width:16px/.test(icon) && /height:16px/.test(icon), '图标容器必须固定 16×16');
  assert.ok(css.includes('.dsh-enh-aux .dsh-enh-aux-icon svg{display:block;width:14px;height:14px}'),
    'v4.2.1 的 SVG 盒规则不得改动（图标几何零回归）');

  // ⑤ 渲染级：两态副键元素类名完全一致 ⇒ 盒宽只由 CSS 决定，两态选中范围必然相等
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v422-range';
  const inputActions = { setDraft: () => {} };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTQ' });
  h.api.enhance(sid, '草稿Q', inputActions, { current: '草稿Q' });
  await flush();
  h.api.storeFor(sid).phase = 'idle';
  const b = loadButtonSpy(h, sid);
  const redoAux = auxBtnOf(b.render('OUTQ', 'plain'));       // 未改 → ⟳（从零重新优化）
  const undoAux = auxBtnOf(b.render('OUTQ 改', 'plain'));   // 已改 → ↩（撤销优化）
  assert.ok(redoAux && undoAux, '两态都必须渲染副键');
  assert.equal(redoAux.props.className, undoAux.props.className, '两态副键类名必须完全一致（盒宽不由内容决定）');
  assert.equal(redoAux.props['data-glyph'], 'redo');
  assert.equal(undoAux.props['data-glyph'], 'undo');
  assert.equal(classEl(redoAux, 'dsh-enh-aux-icon').props.className,
    classEl(undoAux, 'dsh-enh-aux-icon').props.className, '两态图标容器类名一致（共用同一 16×16 盒）');
});

test('V422-02 继续优化蓝色态: 与撤销态逐字同构（仅色相 token 不同），蓝取 state-business-primary', () => {
  const css = decodeChunk('src/client/styles.js');
  const cont = cssRuleOf(css, '.dsh-enh-btn-continue');
  const result = cssRuleOf(css, '.dsh-enh-btn-result');
  assert.ok(cont, '缺 .dsh-enh-btn-continue');
  assert.ok(result, '缺 .dsh-enh-btn-result');
  // ① 同构：把色相 token 归一后两条规则必须**逐字相等**（同一条 6% color-mix 配方）
  assert.equal(cont.replace(/state-business-primary/g, 'TOKEN'), result.replace(/state-success-primary/g, 'TOKEN'),
    '继续优化必须与撤销优化逐字同构（仅色相 token 不同）');
  // ② 蓝 = 宿主自己的蓝色前景 token（深色 #7aaaff / 浅色 #4176e6）
  assert.ok(cont.includes('color:var(--dsw-alias-state-business-primary)'), '蓝字必须取 state-business-primary');
  assert.equal(/brand-primary/.test(cont), false,
    'brand-primary 在本设计系统里是中性色（深色近白 / 浅色近黑），不得当蓝用');
  // ③ 接线：继续优化态挂类名（且仍带居中类，v3.5.5 契约不回归）
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(btn.includes("dsh-enh-btn-text dsh-enh-btn-center dsh-enh-btn-continue"),
    '继续优化态必须挂 dsh-enh-btn-continue（且保留居中类）');
});

test('V422-03 主键三态类名互斥: 撤销 / 继续 / 重新各挂其一，均保留居中类', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v422-classes';
  const inputActions = { setDraft: () => {} };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTC2' });
  h.api.enhance(sid, '草稿C2', inputActions, { current: '草稿C2' });
  await flush();
  h.api.storeFor(sid).phase = 'idle';
  const b = loadButtonSpy(h, sid);
  const classesOf = (el) => mainBtnOf(el).props.className;
  const undoCls = classesOf(b.render('OUTC2', 'plain'));        // 未改 → 撤销优化
  const contCls = classesOf(b.render('OUTC2 改', 'plain'));     // 已改 + 记忆开 → 继续优化
  assert.ok(hasClass(mainBtnOf(b.render('OUTC2', 'plain')), 'dsh-enh-btn-result'));
  assert.ok(hasClass(mainBtnOf(b.render('OUTC2 改', 'plain')), 'dsh-enh-btn-continue'));
  for (const [name, cls, own, others] of [
    ['撤销', undoCls, 'dsh-enh-btn-result', ['dsh-enh-btn-continue', 'dsh-enh-btn-redo']],
    ['继续', contCls, 'dsh-enh-btn-continue', ['dsh-enh-btn-result', 'dsh-enh-btn-redo']],
  ]) {
    assert.ok(cls.includes(own), name + '态必须挂 ' + own);
    for (const o of others) assert.equal(cls.includes(o), false, name + '态不得同时挂 ' + o);
    assert.ok(cls.includes('dsh-enh-btn-center'), name + '态必须保留居中类（v3.5.5 契约）');
    assert.ok(cls.includes('dsh-enh-btn-text'), name + '态必须保留文字锚点类');
  }
  // 记忆关 → 重新优化（独立 helpers 实例：memory:false 才有「已改 + 记忆关」行）
  const h2 = loadHelpers({ memory: false, mode: 'standard' });
  const sid2 = 'sess-v422-classes-off';
  h2.hostStub.respond = () => ({ ok: true, text: 'OUTD' });
  h2.api.enhance(sid2, '草稿D', { setDraft: () => {} }, { current: '草稿D' });
  await flush();
  h2.api.storeFor(sid2).phase = 'idle';
  const b2 = loadButtonSpy(h2, sid2);
  const redoMain = mainBtnOf(b2.render('OUTD 改', 'plain'));
  assert.equal(collectText(redoMain).join(''), 'btnRedo', '前置：已改 + 记忆关 → 重新优化');
  assert.ok(hasClass(redoMain, 'dsh-enh-btn-redo'), '重新优化态必须挂 dsh-enh-btn-redo');
  assert.equal(hasClass(redoMain, 'dsh-enh-btn-result'), false, '重新优化不得带撤销态类名');
  assert.equal(hasClass(redoMain, 'dsh-enh-btn-continue'), false, '重新优化不得带继续优化类名');
  assert.ok(hasClass(redoMain, 'dsh-enh-btn-center'));
});

test('V422-04 重新优化中性底: label-secondary 6% 淡底（与三态同浓度）+ 禁用面板底色', () => {
  const css = decodeChunk('src/client/styles.js');
  const redo = cssRuleOf(css, '.dsh-enh-btn-redo');
  assert.ok(redo, '缺 .dsh-enh-btn-redo');
  assert.ok(redo.includes('color:var(--dsw-alias-label-secondary)'), '重新优化 = 灰字（语义不变）');
  assert.ok(redo.includes('color-mix(in srgb,var(--dsw-alias-label-secondary) 6%,transparent)'),
    '中性底必须与其余两态同浓度（6% color-mix，深浅主题皆可见）');
  assert.equal(/bg-layer-[23]/.test(redo), false,
    '不得用 bg-layer-2/3 作底色——深色主题下正是工具行面板底色（#2c2c2e），会完全看不见');
  // 三态共用同一条 6% 配方（形式统一是需求 4 的验收点）
  for (const sel of ['.dsh-enh-btn-result', '.dsh-enh-btn-continue', '.dsh-enh-btn-redo']) {
    assert.ok(/6%,transparent\)/.test(cssRuleOf(css, sel) || ''), sel + ' 必须走 6% color-mix 淡底');
  }
  // 接线：重新优化态挂类名
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(btn.includes("dsh-enh-btn-text dsh-enh-btn-center dsh-enh-btn-redo"),
    '重新优化态必须挂 dsh-enh-btn-redo（且保留居中类）');
});

test('V42-41 result 消费 effect: 首帧挂起（F1）→ 第二帧用户编辑 ⇒ 消费为 idle + 清结果键；草稿 === backup ⇒ 重新应用结果', () => {
  // ① 切回/挂载首帧：草稿既 ≠ enhanced 也 ≠ backup——v4.2.3（F1·审计处置）首帧一律**挂起**
  //（首帧草稿可能是宿主未回灌的空串或上一会话的陈旧值，不得据此判「用户已编辑」丢弃结果）
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-consume';
  const s = h.api.storeFor(sid);
  s.phase = 'result';
  s.optimized = true;
  s.backup = '原草稿';
  s.enhanced = '旧结果';
  s.memoryRounds = [{ input: '原草稿', output: '旧结果' }];
  h.lsBacking.set(RK(sid), JSON.stringify({ b: '原草稿', e: '旧结果' }));
  assert.ok(h.lsBacking.has(RK(sid)), '前置：结果持久化键在');
  const b = loadButtonSpy(h, sid);
  b.render('用户新写的内容', 'plain');
  assert.equal(s.phase, 'result', '首帧（消费基线未建立）⇒ 挂起：不消费、不删键（F1 修复核心）');
  assert.ok(h.lsBacking.has(RK(sid)), '首帧不得清结果持久化键');
  // 第二帧草稿仍为用户编辑值（非空、≠backup/enhanced）⇒ 真实编辑，消费 + 删键
  b.render('用户新写的内容2', 'plain');
  assert.equal(s.phase, 'idle', '第二帧确认用户真实编辑 ⇒ 消费为 idle');
  assert.equal(s.enhanced, '');
  assert.equal(s.error, null);
  assert.equal(h.lsBacking.has(RK(sid)), false, '真实编辑消费必须清结果持久化键（L1 不可逆语义维持）');
  assert.deepEqual(s.memoryRounds, [{ input: '原草稿', output: '旧结果' }], '消费不动链');
  assert.equal(s.optimized, true, '消费不动 optimized');
  // ② 草稿 === backup（切走期间服务端回灌原始文本）⇒ 自动重新应用结果，不消费（首帧即回灌也允许——安全分支）
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-v42-reapply';
  const s2 = h2.api.storeFor(sid2);
  s2.phase = 'result';
  s2.optimized = true;
  s2.backup = '原草稿';
  s2.enhanced = '旧结果';
  h2.lsBacking.set(RK(sid2), JSON.stringify({ b: '原草稿', e: '旧结果' }));
  const writes = [];
  const b2 = loadButtonSpy(h2, sid2, { inputActions: { setDraft: (v) => writes.push(v) } });
  b2.render('原草稿', 'plain');
  assert.deepEqual(writes, ['旧结果'], '草稿 == backup ⇒ 自动重新应用结果');
  assert.equal(s2.phase, 'result', '重灌分支不消费结果态');
  assert.ok(h2.lsBacking.has(RK(sid2)), '重灌分支不清结果键');
});

test('V1 澄清记录持久化: 刷新恢复 + 草稿清空/切模式清除 + undo 保留 + 失败保留', async () => {
  // ① 刷新恢复（键独立于链键）
  const lsBacking = new Map();
  lsBacking.set(CK('sess-clr-restore'), JSON.stringify([{ q: 'Q1', a: 'a', via: 'option' }, { q: 'Q2', a: '', via: 'keep' }]));
  const h1 = loadHelpers({ memory: true, mode: 'expert' }, { lsBacking });
  const s1 = h1.api.storeFor('sess-clr-restore');
  assert.deepEqual(s1.clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }, { q: 'Q2', a: '', via: 'keep' }],
    'v4.4（V1）：刷新后从 dsh-enh-clarify:<sid> 恢复澄清记录（字段白名单 + via）');
  // ② 三触发之一：草稿清空 → 澄清记录随链一并清
  s1.memoryRounds = [{ input: 'd', output: 'D' }];
  s1.optimized = true;
  h1.api.saveMemoryStore('sess-clr-restore', s1.memoryRounds);
  const btn = loadButton(h1, 'sess-clr-restore');
  btn.render('d', 'plain');
  btn.render('', 'plain');
  assert.equal(h1.lsBacking.has(CK('sess-clr-restore')), false, '清链同步删澄清持久化键');
  assert.deepEqual(h1.api.storeFor('sess-clr-restore').clarifyAnswers, [], '清链同步清内存澄清记录');
  // ③ 三触发之二：切档位 → v4.2.3（F2·用户拍板）只清**切换动作所在会话**（applyModeSwitch 入口），
  // 他会话与已释放会话的澄清键保留（原全局清链 + 残键清扫已删除）
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-clr-mode';
  const s2 = h2.api.storeFor(sid2);
  s2.clarifyAnswers = [{ q: 'Q', a: 'a', via: 'custom' }];
  h2.lsBacking.set(CK(sid2), JSON.stringify(s2.clarifyAnswers));
  h2.lsBacking.set(CK('sess-gone-clr'), JSON.stringify([{ q: 'G', a: 'g', via: 'custom' }]));
  h2.api.applyModeSwitch(sid2, 'expert');
  assert.equal(h2.lsBacking.has(CK(sid2)), false, '切档清除**本会话**澄清键');
  assert.equal(h2.lsBacking.has(CK('sess-gone-clr')), true, '他会话澄清键必须保留（F2：不跨会话清）');
  assert.deepEqual(h2.api.storeFor(sid2).clarifyAnswers, [], '切档清本会话内存澄清记录');
  // ④ undo 保留（V2）+ 失败保留
  const h3 = loadHelpers({ memory: true, mode: 'expert' });
  const sid3 = 'sess-clr-undo';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿U' };
  let call = 0;
  h3.hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    if (call === 2) return { ok: true, text: '终稿U' };
    return { ok: false, code: 'QUOTA' };
  };
  h3.api.enhance(sid3, '草稿U', inputActions, draftRef);
  await flush();
  h3.api.enhance(sid3, '草稿U', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  assert.ok(h3.lsBacking.has(CK(sid3)), '提交即写入澄清持久化键');
  h3.api.undo(sid3, { setDraft: () => {} });
  assert.deepEqual(h3.api.storeFor(sid3).clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V2）：undo 不回退澄清记录');
  assert.ok(h3.lsBacking.has(CK(sid3)), 'undo 不删澄清持久化键');
  // 失败（QUOTA）后重试仍携带
  draftRef.current = '草稿U2';
  h3.api.enhance(sid3, '草稿U2', inputActions, draftRef);
  await flush();
  assert.deepEqual(h3.api.storeFor(sid3).clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }], '失败不清已入库记录');
  draftRef.current = '草稿U3';
  h3.api.enhance(sid3, '草稿U3', inputActions, draftRef);
  await flush();
  const last = h3.hostStub.calls.filter((c) => c.method === 'enhance').pop();
  assert.deepEqual(last.args.answers, [{ q: 'Q1', a: 'a', via: 'option' }], '失败后的请求仍携带澄清记录');
});

test('V3 cancel 不清历史: 连续两轮澄清 → 第二轮取消 → 前轮已入库问答保留', async () => {
  const { api, hostStub, lsBacking } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-clcancel2';
  const inputActions = { setDraft: (v) => {} };
  const draftRef = { current: '草稿C' };
  let call = 0;
  hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    return { ok: true, clarify: [{ q: 'Q2', options: ['c', 'd'] }], text: '' };
  };
  api.enhance(sid, '草稿C', inputActions, draftRef);
  await flush();
  api.enhance(sid, '草稿C', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify', '第二轮澄清');
  api.clarifyCancel(sid, inputActions);
  const s = api.storeFor(sid);
  assert.deepEqual(s.clarify, [], '取消清当前题');
  assert.deepEqual(s.clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }],
    'v4.4（V3）：取消只放弃未提交的题——已入库历史保留（旧实现误清）');
  assert.ok(lsBacking.has(CK(sid)), '取消不删澄清持久化键');
  // 取消后再优化仍携带历史
  draftRef.current = '草稿C2';
  api.enhance(sid, '草稿C2', inputActions, draftRef);
  await flush();
  const last = hostStub.calls.filter((c) => c.method === 'enhance').pop();
  assert.deepEqual(last.args.answers, [{ q: 'Q1', a: 'a', via: 'option' }], '取消后的优化仍携带已答记录');
});

test('V6 专家档固定记忆: memory=false 仍携带链/恒写链（lite 对照不写）；host 侧同口径锚', async () => {
  const h = loadHelpers({ memory: false, mode: 'expert' });
  const sid = 'sess-expmem';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿E' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTE' });
  h.api.enhance(sid, '草稿E', inputActions, draftRef);
  await flush();
  assert.deepEqual(h.api.storeFor(sid).memoryRounds, [{ input: '草稿E', output: 'OUTE' }],
    'v4.4（V6）：专家档记忆开关 false 仍写链');
  draftRef.current = 'OUTE 改';
  h.api.enhance(sid, 'OUTE 改', inputActions, draftRef);
  await flush();
  const second = h.hostStub.calls.filter((c) => c.method === 'enhance')[1];
  assert.ok(second.args.memory && Array.isArray(second.args.memory.rounds) && second.args.memory.rounds.length >= 1
    && second.args.memory.rounds[0].input === '草稿E',
    'v4.4（V6）：专家档开关 false 仍携带 rounds（resolveActualMode 恒视为开；数组为引用，不锁末端长度）');
  assert.equal(second.args.continue, undefined, 'v4.4（V5）：req.continue 死字段已删除');
  // lite 对照：开关 false 不写链不携带
  const hl = loadHelpers({ memory: false, mode: 'lite' });
  const sidl = 'sess-litemem';
  const drl = { current: '草稿L' };
  hl.hostStub.respond = () => ({ ok: true, text: 'OUTL' });
  hl.api.enhance(sidl, '草稿L', { setDraft: () => {} }, drl);
  await flush();
  assert.deepEqual(hl.api.storeFor(sidl).memoryRounds, [], 'lite 开关 false 不写链（开关语义仅 lite/standard 有效）');
  // host 侧同口径源码锚（双侧一致纪律）
  const hostSrc = JSON.parse('"' + fs.readFileSync(path.join(ROOT, 'src/host/enhance-handlers.js'), 'utf8').match(/module\.exports\s*=\s*"([\s\S]*)";?\s*$/)[1] + '"');
  assert.ok(hostSrc.includes("shouldInjectMemory(cfg.memory === true || cfg.mode === 'expert', hasMemory)"),
    'v4.4（V6）：host memoryActive 必须对 expert 档恒视为开');
});

test('V4/V7 wiring: btnRedo/titleRedo/cfgMemoryExpertLocked i18n ZH/EN 成对 + UI 锁定接线锚', () => {
  const i18n = decodeChunk('src/client/i18n.js');
  for (const k of ['btnRedo', 'titleRedo', 'cfgMemoryExpertLocked']) {
    assert.equal((i18n.match(new RegExp(k + ':', 'g')) || []).length, 2, k + ' 必须 ZH/EN 成对');
  }
  assert.ok(i18n.includes("btnRedo: '重新优化'") && i18n.includes("btnRedo: 'Re-optimize'"), 'btnRedo 文案不符');
  const params = decodeChunk('src/client/components/params-tab.js');
  assert.ok(params.includes('cfgMemoryExpertLocked') && params.includes("disabled: cfg.mode === 'expert'"),
    '设置页记忆开关在专家档必须置灰 + 提示');
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  assert.ok(menu.includes('memoryExpertLocked') && menu.includes("if (configState.value.mode === 'expert') return;"),
    '▾ 菜单记忆行在专家档必须置灰不可切');
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(btn.includes('draftBodyOf') && btn.includes("t('btnRedo')"), '按钮三态接线（draftBodyOf + btnRedo）');
  assert.equal(/req\.continue\s*=/.test(btn), false, 'v4.4（V5）：client 不得再写 req.continue 赋值');
  const helpers = decodeChunk('src/client/helpers.js');
  assert.equal(/req\.continue\s*=/.test(helpers), false, 'v4.4（V5）：helpers 不得再写 req.continue 赋值（注释提及字段名合法）');
});

// ---------- v4.2（task-4·§3.1）：fresh（从零重新优化）语义 ----------
// 第 6 参 fresh = true（按钮「重新优化」与副键 ⟳ 两个入口）：请求不带 memory / answers（host
// baseRounds=[] → isContinuation 恒 false），全局已入库澄清记录既不携带也不清空，写链照常；
// 本会话内新答只暂存 freshAnswers，终稿成功才并入全局并落盘。
test('V42-20 fresh 载荷: 不带 memory / 不带 answers；全局 clarifyAnswers 不动不清；结果照常入链 + 非 fresh 复位 freshRun', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-fresh-req';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿F' };
  const prior = [{ q: 'Q1', a: 'a', via: 'option' }];
  h.lsBacking.set(CK(sid), JSON.stringify(prior)); // 已入库澄清记录（模拟跨轮已答）
  const s = h.api.storeFor(sid);
  assert.deepEqual(s.clarifyAnswers, prior, '前置：已入库澄清记录（刷新恢复）');
  h.hostStub.respond = () => ({ ok: true, text: 'FRESH_OUT' });
  h.api.enhance(sid, '草稿F', inputActions, draftRef, undefined, true);
  const first = sentEnhances(h)[0];
  assert.equal(first.args.memory, undefined, '§3.1-1：fresh 请求不得携带 memory（= 新开对话）');
  assert.equal(first.args.answers, undefined, '§3.1-1：freshAnswers 为空 → 不得携带 answers（全局已答记录本次不携带）');
  assert.equal(s.freshRun, true, '§3.1-1：fresh 置 freshRun=true');
  assert.deepEqual(s.freshAnswers, [], '§3.1-1：本会话新答暂存区初始为空');
  await flush();
  assert.deepEqual(s.memoryRounds, [{ input: '草稿F', output: 'FRESH_OUT' }], '§3.1-4：fresh 结果照常入链（写链判定不含 fresh）');
  assert.equal(s.optimized, true, '结果应用 → optimized=true');
  assert.deepEqual(s.clarifyAnswers, prior, '§3.1-1：全局 clarifyAnswers 本次既不携带也不清空');
  assert.equal(h.lsBacking.get(CK(sid)), JSON.stringify(prior), '§3.1-1：澄清持久化键原样保留');
  assert.equal(s.freshRun, false, '§3.1-5：终稿成功 → freshRun 复位');
  assert.deepEqual(s.freshAnswers, [], '§3.1-5：终稿成功 → freshAnswers 清空');
  // 非 fresh（普通「继续优化」）：行为逐字不变（带链 + 带全局已答记录），并复位 freshRun
  draftRef.current = '草稿F2';
  h.api.enhance(sid, '草稿F2', inputActions, draftRef);
  const second = sentEnhances(h)[1];
  assert.ok(second.args.memory && Array.isArray(second.args.memory.rounds) && second.args.memory.rounds.length === 1,
    '§3.1-2：非 fresh 逐字不变——仍携带记忆链');
  assert.deepEqual(second.args.answers, prior, '§3.1-2：非 fresh 逐字不变——仍携带全局已入库澄清记录');
  assert.equal(s.freshRun, false, '§3.1-2：非 fresh 轮次置 freshRun=false（退出 fresh 会话）');
  await flush();
});

test('V42-21 fresh 澄清续跑: 沿袭 fresh（不带 memory、answers=freshAnswers 只暂存）；终稿并入全局并落盘 + 两字段复位', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-clarify';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿Q' };
  const s = h.api.storeFor(sid);
  let call = 0;
  h.hostStub.respond = () => {
    call += 1;
    return call === 1 ? { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' } : { ok: true, text: '终稿F' };
  };
  h.api.enhance(sid, '草稿Q', inputActions, draftRef, undefined, true);
  await flush();
  assert.equal(s.phase, 'clarify');
  assert.equal(s.freshRun, true, '§3.1-7：澄清信号保留 freshRun（续跑仍 fresh）');
  assert.deepEqual(s.freshAnswers, [], '§3.1-7：澄清信号保留暂存区（此处仍空）');
  assert.equal(h.lsBacking.has(CK(sid)), false, '§3.1-1：fresh 会话新答不得落盘');
  // 澄清续跑（ClarifyPanel 只传 5 参 → 靠 freshRun 沿袭）
  h.api.enhance(sid, '草稿Q', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  const second = sentEnhances(h)[1];
  assert.equal(second.args.memory, undefined, '§3.1-3：fresh 会话内澄清续跑沿袭 fresh（不带 memory）');
  assert.deepEqual(second.args.answers, [{ q: 'Q1', a: 'a', via: 'option' }], '§3.1-1/3：answers = freshAnswers（本轮新答先并入暂存区）');
  assert.deepEqual(s.clarifyAnswers, [], '全局 clarifyAnswers 全程不被 fresh 会话写入');
  assert.equal(h.lsBacking.has(CK(sid)), false, '§3.1-1：续跑仍不落盘（只暂存）');
  assert.deepEqual(s.freshAnswers, [{ q: 'Q1', a: 'a', via: 'option' }], '§3.1-1：新答并入 freshAnswers');
  await flush();
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.memoryRounds, [{ input: '草稿Q', output: '终稿F' }], '§3.1-4：fresh 会话终稿照常入链');
  assert.deepEqual(s.clarifyAnswers, [{ q: 'Q1', a: 'a', via: 'option' }], '§3.1-5：终稿成功把 freshAnswers 并入全局');
  assert.equal(h.lsBacking.get(CK(sid)), JSON.stringify([{ q: 'Q1', a: 'a', via: 'option' }]), '§3.1-5：并入后必须 saveClarifyStore');
  assert.equal(s.freshRun, false, '§3.1-5：freshRun 复位');
  assert.deepEqual(s.freshAnswers, [], '§3.1-5：freshAnswers 清空');
});

test('V42-22 fresh 暂存封顶: 暂存区合计口径 9 条（保留最近）；终稿并入全局同口径', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-cap';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿9F' };
  const s = h.api.storeFor(sid);
  let call = 0;
  h.hostStub.respond = () => {
    call += 1;
    if (call <= 4) {
      return {
        ok: true,
        clarify: [
          { q: 'Q' + call + 'a', options: ['1', '2'] },
          { q: 'Q' + call + 'b', options: ['1', '2'] },
          { q: 'Q' + call + 'c', options: ['1', '2'] },
        ],
        text: '',
      };
    }
    return { ok: true, text: '终稿9F' };
  };
  h.api.enhance(sid, '草稿9F', inputActions, draftRef, undefined, true);
  await flush();
  for (let round = 1; round <= 3; round++) {
    h.api.enhance(sid, '草稿9F', inputActions, draftRef, {
      answers: [
        { q: 'Q' + round + 'a', a: 'a' + round },
        { q: 'Q' + round + 'b', a: 'b' + round },
        { q: 'Q' + round + 'c', a: 'c' + round },
      ],
    });
    await flush();
  }
  assert.equal(call, 4, '1 次首轮 + 3 次澄清续跑');
  assert.equal(s.clarifyAnswers.length, 0, '全局记录全程为空（fresh 只暂存）');
  assert.equal(h.lsBacking.has(CK(sid)), false, '§3.1-1：fresh 会话全程不落盘');
  assert.equal(s.freshAnswers.length, 9, '§3.1-1：freshAnswers 合计口径封顶 9');
  assert.deepEqual(s.freshAnswers[0], { q: 'Q1a', a: 'a1' }, '时序不乱（前轮在前）');
  assert.deepEqual(s.freshAnswers[8], { q: 'Q3c', a: 'c3' });
  // 第 4 轮提交（12 条）→ 终稿：并入全局同口径 slice(-9)，最早一轮让位
  h.api.enhance(sid, '草稿9F', inputActions, draftRef, {
    answers: [
      { q: 'Q4a', a: 'a4' },
      { q: 'Q4b', a: 'b4' },
      { q: 'Q4c', a: 'c4' },
    ],
  });
  await flush();
  assert.equal(s.phase, 'result');
  assert.equal(s.clarifyAnswers.length, 9, '§3.1-5：终稿并入全局同口径（slice(-9)）');
  assert.deepEqual(s.clarifyAnswers[0], { q: 'Q2a', a: 'a2' }, '超限保留最近（最早一轮让位）');
  assert.deepEqual(s.clarifyAnswers[8], { q: 'Q4c', a: 'c4' });
  assert.equal(JSON.parse(h.lsBacking.get(CK(sid))).length, 9, '并入后落盘（saveClarifyStore）');
  assert.equal(s.freshRun, false);
  assert.deepEqual(s.freshAnswers, []);
});

test('V42-23 fresh 失败保留: 业务失败（TIMEOUT）与网络失败都不作废 fresh 会话（重试仍不带 memory）', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-fail';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿X' };
  const s = h.api.storeFor(sid);
  let call = 0;
  h.hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    return { ok: false, code: 'TIMEOUT' };
  };
  h.api.enhance(sid, '草稿X', inputActions, draftRef, undefined, true);
  await flush();
  assert.equal(s.phase, 'clarify');
  h.api.enhance(sid, '草稿X', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  assert.equal(s.phase, 'idle');
  assert.equal(s.error, 'TIMEOUT');
  assert.equal(s.freshRun, true, '§3.1-6：失败保留 freshRun（重试仍 fresh）');
  assert.deepEqual(s.freshAnswers, [{ q: 'Q1', a: 'a', via: 'option' }], '§3.1-6：失败保留 freshAnswers');
  assert.deepEqual(s.clarifyAnswers, [], 'fresh 会话不写全局记录');
  assert.equal(h.lsBacking.has(CK(sid)), false, 'fresh 会话不落盘');
  // 网络失败（Promise 拒绝）：同样保留
  h.hostStub.respond = () => Promise.reject(new Error('net down'));
  h.api.enhance(sid, '草稿X', inputActions, draftRef, { answers: [{ q: 'Q2', a: 'b', via: 'option' }] });
  const netCall = sentEnhances(h)[2];
  assert.equal(netCall.args.memory, undefined, '§3.1-3/6：重试仍走 fresh（不带 memory）');
  assert.deepEqual(netCall.args.answers, [{ q: 'Q1', a: 'a', via: 'option' }, { q: 'Q2', a: 'b', via: 'option' }],
    '重试请求携带本会话已答（freshAnswers 累计）');
  await flush();
  assert.equal(s.error, 'NETWORK');
  assert.equal(s.freshRun, true, '§3.1-6：网络失败保留 freshRun');
  assert.deepEqual(s.freshAnswers, [{ q: 'Q1', a: 'a', via: 'option' }, { q: 'Q2', a: 'b', via: 'option' }], '网络失败保留 freshAnswers');
  assert.deepEqual(s.clarifyAnswers, [], '全局记录仍为空');
});

test('V42-24 fresh 取消作废: cancelEnhance → freshRun/freshAnswers 复位（半截 fresh 会话不留残）', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-cancel';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿K' };
  const s = h.api.storeFor(sid);
  let call = 0;
  h.hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    return new Promise(() => {}); // 在途永不完成
  };
  h.api.enhance(sid, '草稿K', inputActions, draftRef, undefined, true);
  await flush();
  h.api.enhance(sid, '草稿K', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  assert.equal(s.phase, 'enhancing');
  assert.equal(s.freshRun, true);
  assert.deepEqual(s.freshAnswers, [{ q: 'Q1', a: 'a', via: 'option' }]);
  h.api.cancelEnhance(sid, inputActions);
  assert.equal(s.phase, 'idle');
  assert.equal(s.freshRun, false, '§3.1-9：取消 → fresh 会话作废（freshRun 复位）');
  assert.deepEqual(s.freshAnswers, [], '§3.1-9：取消清空暂存答案');
  assert.deepEqual(s.clarifyAnswers, [], '全局记录不受影响（fresh 会话未写入）');
  assert.ok(h.hostStub.calls.some((c) => c.method === 'cancel'), '取消必须发 cancel RPC（既有契约）');
});

test('V42-25 fresh 结果被丢弃作废: 增强中用户改草稿 → 不入链、fresh 两字段复位', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-discard';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿D' };
  const s = h.api.storeFor(sid);
  let call = 0;
  let release = null;
  h.hostStub.respond = () => {
    call += 1;
    if (call === 1) return { ok: true, clarify: [{ q: 'Q1', options: ['a', 'b'] }], text: '' };
    return new Promise((resolve) => { release = resolve; });
  };
  h.api.enhance(sid, '草稿D', inputActions, draftRef, undefined, true);
  await flush();
  h.api.enhance(sid, '草稿D', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a', via: 'option' }] });
  await flush();
  assert.equal(s.phase, 'enhancing');
  assert.equal(s.freshRun, true);
  draftRef.current = '用户改过的草稿'; // 飞行期编辑 → 结果被丢弃
  release({ ok: true, text: '迟到终稿' });
  await flush();
  assert.equal(s.phase, 'idle');
  assert.equal(s.enhanced, '');
  assert.deepEqual(s.memoryRounds, [], '丢弃不入链');
  assert.equal(s.freshRun, false, '§3.1-8：结果被丢弃 → fresh 会话作废');
  assert.deepEqual(s.freshAnswers, [], '§3.1-8：作废即清空暂存答案');
  assert.deepEqual(s.clarifyAnswers, [], '全局记录不受影响');
  assert.equal(h.lsBacking.has(CK(sid)), false);
});

test('V42-26 undo 清 fresh: 撤销后 freshRun/freshAnswers 复位（fresh 字段与结果态同寿命）', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-undo-fresh';
  const s = h.api.storeFor(sid);
  s.phase = 'idle';
  s.optimized = true;
  s.backup = 'b1';
  s.enhanced = 'B1';
  s.memoryRounds = [{ input: 'b1', output: 'B1' }];
  s.freshRun = true;
  s.freshAnswers = [{ q: 'Q1', a: 'a', via: 'option' }];
  const writes = [];
  h.api.undo(sid, { setDraft: (v) => writes.push(v) });
  assert.deepEqual(writes, ['b1'], '撤销回退点 = backup（body === 末轮 input）');
  assert.equal(s.freshRun, false, '§3.1-undo：撤销清 freshRun');
  assert.deepEqual(s.freshAnswers, [], '§3.1-undo：撤销清 freshAnswers');
  assert.equal(s.optimized, false, '链空 → 回首次态');
});

test('V42-27 clarifyCancel 作废 fresh: 取消清两字段 → 再 ⟳ 不带 answers、作废答案不得并入全局', async () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-v42-fresh-clcancel';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿CC' };
  const s = h.api.storeFor(sid);
  let call = 0;
  h.hostStub.respond = () => {
    call += 1;
    if (call <= 2) return { ok: true, clarify: [{ q: 'Q' + call, options: ['a', 'b'] }], text: '' };
    return { ok: true, text: 'T' + call };
  };
  h.api.enhance(sid, '草稿CC', inputActions, draftRef, undefined, true);
  await flush();
  h.api.enhance(sid, '草稿CC', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a1', via: 'option' }] });
  await flush();
  assert.equal(s.phase, 'clarify');
  assert.equal(s.freshRun, true);
  assert.deepEqual(s.freshAnswers, [{ q: 'Q1', a: 'a1', via: 'option' }], '前置：fresh 会话已暂存新答');
  assert.deepEqual(s.clarifyAnswers, [], '前置：尚未并入全局');
  h.api.clarifyCancel(sid, inputActions);
  assert.equal(s.phase, 'idle');
  assert.equal(s.freshRun, false, '取消澄清 = 本次 fresh 会话作废（清 freshRun）');
  assert.deepEqual(s.freshAnswers, [], '取消澄清清空暂存答案');
  assert.equal(h.lsBacking.has(CK(sid)), false, '作废的暂存答案不得落盘');
  // 作废后再走 fresh（副键 ⟳ 入口）：请求不得携带上一会话的暂存答案
  h.api.enhance(sid, '草稿CC', inputActions, draftRef, undefined, true);
  const again = sentEnhances(h)[2];
  assert.equal(again.args.answers, undefined, '作废后再 ⟳：请求不带 answers');
  assert.equal(again.args.memory, undefined, '作废后再 ⟳：请求不带 memory');
  await flush();
  assert.deepEqual(s.clarifyAnswers, [], '作废的暂存答案不得在终稿并入全局');
});

test('V42-28 非 fresh / 清链作废暂存: 非 fresh 轮次清 freshAnswers；切模式与草稿清空清两字段', async () => {
  // ① 非 fresh 轮次不得把被放弃的 fresh 暂存答案并入全局（否则「从零」答案会污染普通轮次）
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-fresh-abandon';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿A2' };
  const s = h.api.storeFor(sid);
  s.freshRun = true;
  s.freshAnswers = [{ q: 'Q1', a: 'a1', via: 'option' }]; // 被放弃的 fresh 暂存
  h.hostStub.respond = () => ({ ok: true, text: 'T9' });
  h.api.enhance(sid, '草稿A2', inputActions, draftRef); // 非 fresh（无 clarifyOpts）
  assert.equal(s.freshRun, false, '非 fresh 轮次置 freshRun=false');
  assert.deepEqual(s.freshAnswers, [], '非 fresh 轮次必须清空被放弃的 fresh 暂存');
  await flush();
  assert.deepEqual(s.clarifyAnswers, [], '非 fresh 终稿不得并入被放弃的 fresh 暂存答案');
  assert.equal(h.lsBacking.has(CK(sid)), false, '未并入即不落盘');

  // ② 清链（切档位）：fresh 两字段复位——v4.2.3（F2）：经 applyModeSwitch（会话级入口），只清目标会话
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-v42-chain-mode';
  const s2 = h2.api.storeFor(sid2);
  s2.freshRun = true;
  s2.freshAnswers = [{ q: 'Q7', a: 'a7', via: 'option' }];
  h2.api.applyModeSwitch(sid2, 'expert');
  assert.equal(s2.freshRun, false, '切档位清链必须清 freshRun');
  assert.deepEqual(s2.freshAnswers, [], '切档位清链必须清 freshAnswers');

  // ③ 清链（草稿「非空 → 空」跳变 = 手动清空 / 发送成功）：fresh 两字段复位
  const h3 = loadHelpers({ memory: true, mode: 'standard' });
  const sid3 = 'sess-v42-chain-draft';
  const s3 = h3.api.storeFor(sid3);
  s3.memoryRounds = [{ input: 'x', output: 'X' }];
  s3.optimized = true;
  s3.freshRun = true;
  s3.freshAnswers = [{ q: 'Q8', a: 'a8', via: 'option' }];
  const btn = loadButton(h3, sid3);
  btn.render('x', 'plain');
  btn.render('', 'plain');
  assert.equal(s3.freshRun, false, '草稿清空清链必须清 freshRun');
  assert.deepEqual(s3.freshAnswers, [], '草稿清空清链必须清 freshAnswers');
});

// ---------- v4.2（task-4·§5.5/§5.6/§5.7）：host 零改动合同 / 箭头动画 / UI 接线 ----------
// 媒体块提取（不用正则）：从 marker 起按花括号配对切片
const mediaBlocksOf = (src, marker) => {
  const out = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(marker, from);
    if (start === -1) break;
    const open = src.indexOf('{', start);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let k = open; k < src.length; k++) {
      const ch = src.charAt(k);
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = k; break; } }
    }
    if (end === -1) break;
    out.push(src.slice(start, end + 1));
    from = end + 1;
  }
  return out;
};

test('V42-30 host 零改动合同: isContinuation 双门（memoryActive + baseRounds.length>0）；无 rounds → 单条 user 消息（行为锚）', () => {
  const host = decodeChunk('src/host/enhance-handlers.js');
  // §二.1：请求不带 memory → baseRounds = [] → hasMemory = false → isContinuation 恒 false
  assert.ok(host.includes('const baseRounds = args && args.memory && Array.isArray(args.memory.rounds)'), 'analyze：请求不带 memory → baseRounds=[]');
  assert.ok(host.includes('const hasMemory = memRounds.length > 0;'), 'hasMemory 只看优化轮（D17）');
  assert.ok(host.includes("const memoryActive = shouldInjectMemory(cfg.memory === true || cfg.mode === 'expert', hasMemory);"), 'memoryActive 判定单点');
  assert.ok(host.includes('state.isContinuation = memoryActive && baseRounds.length > 0 && memDelta !== null'), '§二.1：isContinuation 必须双门——fresh 请求恒 false（不注入 CONTINUE_PROMPT / 本轮修改）');
  assert.ok(host.includes('if (memoryActive && baseRounds.length > 0) {'), '§二.1：memDelta 只在有 rounds 时计算');
  assert.ok(host.includes('const built = buildChatMessages(memRounds, finalText,'), '§二.2：assemble 记忆分支');
  assert.ok(host.includes("messages = [{ id: 'enhance-' + sessionId + '-' + seq, role: 'user'"), '§二.2：无记忆分支 = 单条 user 消息');
  assert.ok(host.includes('const clarifyAnswers = Array.isArray(args && args.answers)'), '§二.3：请求不带 answers → clarifyAnswers=[]');
  assert.equal(host.includes('memoryRounds.push'), false, '§二.4：host 不持有链（入链是 client 侧行为）');
  // 行为锚：与发布产物同源的纯函数（src/host/pure.js）
  const pure = decodeChunk('src/host/pure.js');
  const api = new Function(pure + ';return { buildChatMessages: buildChatMessages, shouldInjectMemory: shouldInjectMemory, wrapUserText: wrapUserText, buildClarifyMessage: buildClarifyMessage, computeEditDelta: computeEditDelta };')();
  assert.equal(api.shouldInjectMemory(true, false), false, '开关开但无 rounds → 不注入（等价新开对话）');
  const single = api.buildChatMessages([], '正文', 'enhance-x-1', 8000);
  assert.equal(single.messages.length, 1, '无 rounds → 单条消息');
  assert.equal(single.messages[0].role, 'user');
  assert.equal(single.messages[0].content[0].text, '正文', '单条消息正文 = 本轮最终 user 文本');
  assert.deepEqual(api.computeEditDelta('', '正文'), { added: [], removed: [] }, '无上一轮输出 → 差异为空 → isContinuation 必为 false');
  assert.deepEqual(JSON.parse(api.wrapUserText('草稿', [], false).split('\n')[1]), { originalDraft: '草稿' },
    '§二.3：请求不带 answers → 证据正文 JSON 无 clarifyAnswers 字段');
  assert.equal(api.buildClarifyMessage([], 8000), '', '§二.3：无 answers → 不注入澄清参考消息');
});

test('V42-31 箭头动画: ▾ 触发器 caret span（aria-expanded 唯一状态源）+ 展开态 rotate(180deg) + chip 箭头 + reduced-motion 关闭', () => {
  const menu = decodeChunk('src/client/components/enhance-menu.js');
  assert.ok(menu.includes("'aria-expanded': open ? 'true' : 'false'"), '§3.3：aria-expanded 仍是动画唯一状态源（不得新增状态/类名切换）');
  assert.equal(countOf(menu, 'dsh-enh-menu-caret'), 1, '§3.3：caret 类名恰 1 处（无类名切换、注释不含该类名）');
  const trig = menu.indexOf("'aria-expanded': open ? 'true' : 'false'");
  const caret = menu.indexOf("className: 'dsh-enh-menu-caret'");
  assert.ok(trig !== -1 && caret > trig && caret - trig < 600, '§3.3：caret span 必须落在 ▾ 触发器元素构造内（紧邻 aria-expanded）');
  const css = decodeChunk('src/client/styles.js');
  assert.equal(countOf(css, '.dsh-enh-menu-caret{display:inline-block;transform-origin:center;transition:transform .18s ease}'), 1,
    '§3.4：caret 基础规则必须逐字存在且唯一（transition:transform .18s ease）');
  assert.equal(countOf(css, '.dsh-enh-menu-trigger[aria-expanded="true"] .dsh-enh-menu-caret{transform:rotate(180deg)}'), 1,
    '§3.4：展开态 caret 旋转 180° 规则缺失或重复');
  // chip select 箭头：基础规则补 transition（保留 translateY(-50%)）+ 两条展开态规则
  const arrowAt = css.indexOf('.dsh-plg-mselect-arrow{position:absolute');
  assert.ok(arrowAt !== -1, '§3.4：.dsh-plg-mselect-arrow 基础规则必须仍在（绝对定位形态）');
  const arrowBody = css.slice(arrowAt, css.indexOf('}', arrowAt));
  assert.ok(arrowBody.includes('transform:translateY(-50%)'), '§3.4：chip 箭头基础规则的 translateY(-50%) 不得丢失');
  assert.ok(arrowBody.includes('transition:transform .18s ease'), '§3.4：chip 箭头基础规则必须补 transition:transform .18s ease');
  assert.equal(countOf(css, '.dsh-plg-mselect-trigger[aria-expanded="true"] .dsh-plg-mselect-arrow{transform:translateY(-50%) rotate(180deg)}'), 1,
    '§3.4：基础带 translateY(-50%) → 展开态必须显式带上（否则垂直居中丢失）');
  assert.equal(countOf(css, '.dsh-plg-params-group .dsh-plg-mselect-trigger[aria-expanded="true"] .dsh-plg-mselect-arrow{transform:rotate(180deg)}'), 1,
    '§3.4：params 作用域基础是 transform:none → 展开态只写 rotate（权重 0-4-0 压过 0-2-0）');
  // reduced-motion：既有关闭块内关掉两条 transition（媒体块唯一）
  const rm = mediaBlocksOf(css, '@media (prefers-reduced-motion: reduce)');
  assert.equal(rm.length, 1, '降低动效偏好媒体块必须唯一（在既有块内扩展）');
  assert.ok(rm[0].includes('.dsh-enh-spin{animation:none}'), '既有 spin 关闭不得回归删除');
  assert.ok(rm[0].includes('dsh-enh-menu-caret{transition:none}'), '§3.4：reduced-motion 必须关掉 caret 的方向切换过渡');
  assert.ok(rm[0].includes('dsh-plg-mselect-arrow{transition:none}'), '§3.4：reduced-motion 必须关掉 chip 箭头的方向切换过渡');
  assert.equal(countOf(rm[0], 'transition:none'), 2, '两条 transition 关闭各一次（祖先作用域选择器压过同权重后出现的声明）');
});

test('V42-32 UI 接线: .dsh-enh-split=[aux, main, EnhanceMenu]；main 仍 button+mainRef；aux 字形/tabIndex；i18n 成对 + 空输入邻近契约', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-v42-wire';
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿W' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUTW' });
  h.api.enhance(sid, '草稿W', inputActions, draftRef);
  await flush();
  const b = loadButtonSpy(h, sid);
  const el = b.render('OUTW', 'plain');
  const split = splitOf(el);
  assert.ok(split, '缺 .dsh-enh-split 组合体');
  const kids = split.children.filter((x) => x !== null && x !== undefined);
  assert.equal(kids.length, 3, '§3.2：split 子元素恒为 [aux, main, EnhanceMenu] 三槽');
  assert.ok(hasClass(kids[0], 'dsh-enh-aux'), '§3.2：首位必须是副键');
  assert.equal(kids[1], mainBtnOf(el), '§3.2：次位必须是主键');
  assert.equal(typeof kids[2].props.onOpenChange, 'function', '§3.2：末位必须是 EnhanceMenu（受控开合不变）');
  assert.equal(kids[2].props.anchorRef, mainBtnOf(el).props.ref, '菜单锚点 = 主键 ref（既有契约）');
  const main = mainBtnOf(el);
  assert.equal(main.type, 'button');
  assert.equal(main.props['aria-label'], 'enhanceButton');
  assert.ok(main.props.ref && typeof main.props.ref === 'object' && 'current' in main.props.ref, '§3.2：main 必须保留 ref: mainRef');
  const aux = auxBtnOf(el);
  assert.equal(aux.type, 'button');
  assert.equal(aux.props.tabIndex, -1, '§3.2：副键 tabIndex:-1（不参与 Tab 序列）');
  assert.equal(aux.props.title, 'auxRedo');
  assert.equal(aux.props['aria-label'], 'auxRedo', '§3.2：副键语义由 title/aria-label 承担');
  const icon = classEl(aux, 'dsh-enh-aux-icon');
  assert.ok(icon && textOf(icon) === '⟳', '§3.2/§3.4：字形在 span.dsh-enh-aux-icon（未改态 ⟳）');
  // 源码锚（防「注释有、代码无」）+ 空输入邻近契约 + ✨ 饱和度判定
  const btn = decodeChunk('src/client/components/enhance-button.js');
  assert.ok(btn.includes("className: 'dsh-enh-aux'") && btn.includes("className: 'dsh-enh-aux-icon'"), '按钮 chunk 缺副键/字形类名接线');
  assert.ok(btn.includes('dsh-enh-split'), '组合体容器接线缺失');
  assert.ok(windowHas(btn, 'if (empty) {', 'setMenuOpen((v) => !v)', 500), 'v4.2 不得破坏空输入邻近契约（≤500 字符内 setMenuOpen 函数式切换）');
  assert.equal(countOf(btn, "configState.value.memory === true || configState.value.mode === 'expert' ? '' : ' dsh-enh-icon-dim'"), 1,
    '§3.2：✨ 饱和度判定逐字不变且唯一');
  // i18n：auxRedo/auxUndo 成对 + titleRedo 新文案 + btnRedo/btnContinue 不变 + ZH/EN 键集合相等
  const i18n = decodeChunk('src/client/i18n.js');
  for (const k of ['auxRedo', 'auxUndo', 'titleRedo']) {
    assert.equal(countOf(i18n, k + ':'), 2, k + ' 必须 ZH/EN 成对');
  }
  assert.ok(i18n.includes("auxRedo: '从零重新优化：本次不带记忆上下文（类似新开对话）'")
    && i18n.includes("auxRedo: 'Re-optimize from scratch (no memory context this run)'"), '§3.5：auxRedo 文案不符（ZH/EN）');
  assert.ok(i18n.includes("auxUndo: '撤销优化：恢复本轮优化前的草稿'")
    && i18n.includes("auxUndo: 'Undo: restore the draft from before this optimization'"), '§3.5：auxUndo 文案不符（ZH/EN）');
  assert.ok(i18n.includes("titleRedo: '重新优化：从零重跑（本次不带记忆上下文）'")
    && i18n.includes("titleRedo: 'Re-optimize from scratch (this run carries no memory context)'"), '§3.5：titleRedo 文案未改写（ZH/EN）');
  assert.ok(i18n.includes("btnRedo: '重新优化'") && i18n.includes("btnRedo: 'Re-optimize'"), '§3.5：btnRedo 文案不变');
  assert.ok(i18n.includes("btnContinue: '继续优化'") && i18n.includes("btnContinue: 'Continue'"), '§3.5：btnContinue 文案不变');
  const tables = new Function(i18n + ';return { ZH: ZH, EN: EN };')();
  assert.deepEqual(Object.keys(tables.ZH).sort(), Object.keys(tables.EN).sort(), '§3.5：ZH/EN 键集合必须完全相等');
});

// ================= 多会话隔离审核（audit-2026-09-27·用户反馈「不同会话之间状态互相干扰」） =================
// 口径：把跨会话链路逐条钉成可复现用例。凡「应有行为」与当前实现不符者标 { todo } —— 红点作为缺陷证据
// 保留在案（node:test 的 todo 不计失败，npm test 仍全绿）；修复后去掉 todo 即转为正式回归。
// 每条用例都打印 [审核] 行：实测值 + 预期，便于审核报告直接引用。
const auditNote = (id, observed, expect) => {
  console.log('  [审核] ' + id + ' 实测: ' + observed + (expect ? '\n         预期: ' + expect : ''));
};
const hostSrcOf = () => JSON.parse('"' + fs.readFileSync(path.join(ROOT, 'src/host/enhance-handlers.js'), 'utf8').match(/module\.exports\s*=\s*"([\s\S]*)";?\s*\n$/)[1] + '"');

test('AUDIT-01 跨会话·在途切换: A 在途时切到 B，A 的结果不得写进 B 的草稿或状态', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A1'; const sidB = 'audit-B1';
  let settle = null;
  h.hostStub.respond = () => new Promise((r) => { settle = r; });
  const writesA = [];
  const b = loadButton(h, sidA, { inputActions: { setDraft: (v) => writesA.push(v) } });
  const elA = b.render('A 的草稿', 'plain');
  const sA = h.api.storeFor(sidA); const sB = h.api.storeFor(sidB);
  mainBtnOf(elA).props.onClick();
  assert.equal(sA.phase, 'enhancing', 'A 已进入在途');
  const seqA = sA.seq;
  b.render('B 的草稿', 'plain', sidB); // 实例复用：只换 sessionId prop（渲染器语义）⇒ livenessRef.current 已指向 B
  assert.equal(h.api.getFocusedSession(), sidB, '切到 B 后聚焦会话 = B（v4.2.3：away 判定改实例本地 livenessRef）');
  settle({ ok: true, text: 'A 的优化结果' });
  await flush();
  auditNote('AUDIT-01',
    'A: phase=' + sA.phase + ' enhanced=' + JSON.stringify(sA.enhanced) + ' 链=' + sA.memoryRounds.length + ' 结果键=' + h.lsBacking.has(RK(sidA))
    + ' | B: phase=' + sB.phase + ' 链=' + sB.memoryRounds.length + ' 结果键=' + h.lsBacking.has(RK(sidB)) + ' | A 草稿写入=' + JSON.stringify(writesA));
  assert.deepEqual(writesA, [], 'away 语义：切走后结果只暂存、不注入草稿');
  assert.equal(sA.phase, 'result');
  assert.ok(h.lsBacking.has(RK(sidA)), 'A 的结果必须持久化（返回时靠它恢复）');
  assert.equal(sB.phase, 'idle', 'B 的状态不得被 A 的完成改写');
  assert.deepEqual(sB.memoryRounds, [], 'B 不得继承 A 的链');
  assert.equal(h.lsBacking.has(RK(sidB)), false, 'B 不得出现结果键');
  assert.equal(sA.seq, seqA, 'A 的 seq 不受会话切换影响');
});

test('AUDIT-02 跨会话·清链触发: B 的草稿「非空→空」只清 B 的链，A 不受影响', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A2'; const sidB = 'audit-B2';
  const sA = h.api.storeFor(sidA); const sB = h.api.storeFor(sidB);
  sA.memoryRounds = [{ input: 'a', output: 'A1' }]; sA.optimized = true; h.api.saveMemoryStore(sidA, sA.memoryRounds);
  sB.memoryRounds = [{ input: 'b', output: 'B1' }]; sB.optimized = true; h.api.saveMemoryStore(sidB, sB.memoryRounds);
  const b = loadButton(h, sidB);
  b.render('B 的草稿', 'plain');
  b.render('', 'plain'); // 非空→空跳变（手动清空 / 发送成功）
  auditNote('AUDIT-02', 'B 链=' + sB.memoryRounds.length + '（键=' + h.lsBacking.has(MK(sidB)) + '）B.optimized=' + sB.optimized + ' | A 链=' + sA.memoryRounds.length + '（键=' + h.lsBacking.has(MK(sidA)) + '）A.optimized=' + sA.optimized);
  assert.deepEqual(sB.memoryRounds, [], 'B 自己的链被清');
  assert.equal(sB.optimized, false);
  assert.equal(sA.memoryRounds.length, 1, 'A 的链不得被 B 的清链触发清掉');
  assert.equal(sA.optimized, true);
  assert.ok(h.lsBacking.has(MK(sidA)), 'A 的持久化链键保留');
});

// v4.2.3（F2·用户拍板）：切档位只清「切换动作所在会话」的链——B/C 的链与残键必须存活
test('AUDIT-03 跨会话·切档位: 在 A 切档只清 A 的链与澄清记录，B（挂载）与 C（未挂载残键）全部保留', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A3'; const sidB = 'audit-B3'; const sidC = 'audit-C3';
  const sA = h.api.storeFor(sidA); const sB = h.api.storeFor(sidB);
  sA.memoryRounds = [{ input: 'a', output: 'A1' }]; sA.optimized = true; sA.clarifyAnswers = [{ q: 'qa', a: 'aa' }];
  h.api.saveMemoryStore(sidA, sA.memoryRounds); h.lsBacking.set(CK(sidA), JSON.stringify(sA.clarifyAnswers));
  sB.memoryRounds = [{ input: 'b', output: 'B1' }]; sB.optimized = true; h.api.saveMemoryStore(sidB, sB.memoryRounds);
  h.lsBacking.set(MK(sidC), JSON.stringify([{ input: 'c', output: 'C1' }])); // 未挂载会话只剩持久化键
  h.api.applyModeSwitch(sidA, 'expert'); // 在会话 A 里切档位（v4.2.3 唯一入口）
  auditNote('AUDIT-03', '切档后 A 链=' + sA.memoryRounds.length + ' B 链=' + sB.memoryRounds.length + ' A 澄清记录=' + sA.clarifyAnswers.length
    + ' A 澄清键=' + h.lsBacking.has(CK(sidA)) + ' C 持久化链键=' + h.lsBacking.has(MK(sidC)),
    'v4.2.3 语义：切档只清切换动作所在会话（A）；B/C 存活（原全局清链行为已按用户拍板废除）');
  assert.equal(sA.memoryRounds.length, 0, '切换会话 A 被清（预期内）');
  assert.equal(sA.clarifyAnswers.length, 0, 'A 的澄清记录随链清');
  assert.equal(h.lsBacking.has(CK(sidA)), false, 'A 的澄清键删');
  assert.equal(sB.memoryRounds.length, 1, '其它会话的链必须保留（修复点）');
  assert.ok(h.lsBacking.has(MK(sidB)), '其它会话的链键保留');
  assert.ok(h.lsBacking.has(MK(sidC)), '未挂载会话的持久化链键保留（修复点）');
});

test('AUDIT-04 返回会话·结果回注: 草稿 === backup ⇒ 自动重新应用结果（正确链路）', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'audit-A4';
  const s = h.api.storeFor(sid);
  s.phase = 'result'; s.backup = '原稿'; s.enhanced = '优化结果'; s.optimized = true;
  h.lsBacking.set(RK(sid), JSON.stringify({ b: '原稿', e: '优化结果' }));
  const writes = [];
  const b = loadButton(h, sid, { inputActions: { setDraft: (v) => writes.push(v) } });
  b.render('原稿', 'plain'); // 宿主回灌的是原文 ⇒ 应自动回注结果
  auditNote('AUDIT-04', '草稿写入=' + JSON.stringify(writes) + ' phase=' + s.phase + ' 结果键=' + h.lsBacking.has(RK(sid)));
  assert.deepEqual(writes, ['优化结果'], '原文回灌 ⇒ 自动重新应用结果');
  assert.equal(s.phase, 'result');
  assert.ok(h.lsBacking.has(RK(sid)));
});

// v4.2.3（F1·审计处置）：首帧一律挂起（空串=未回灌/刷新、陈旧草稿=实例复用换会话），
// 不再据此丢弃暂存结果；第二帧草稿回灌为 backup ⇒ 自动回注。原 todo 缺陷证据转正为回归断言。
test('AUDIT-05 返回会话·结果保留: 首帧空草稿/陈旧草稿 ⇒ 挂起不丢；第二帧回灌 backup ⇒ 自动回注', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'audit-A5';
  const s = h.api.storeFor(sid);
  s.phase = 'result'; s.backup = '原稿'; s.enhanced = '优化结果'; s.optimized = true;
  h.lsBacking.set(RK(sid), JSON.stringify({ b: '原稿', e: '优化结果' }));
  const writes = [];
  const b = loadButton(h, sid, { inputActions: { setDraft: (v) => writes.push(v) } });
  b.render('', 'plain'); // 切回会话的首帧：宿主还没把草稿回灌
  auditNote('AUDIT-05', '首帧空草稿 ⇒ phase=' + s.phase + ' enhanced=' + JSON.stringify(s.enhanced) + ' 结果键=' + h.lsBacking.has(RK(sid))
    + ' 草稿写入=' + JSON.stringify(writes));
  assert.equal(s.phase, 'result', '首帧空草稿必须挂起（F1 修复核心）');
  assert.equal(s.enhanced, '优化结果', '结果不得被丢弃');
  assert.ok(h.lsBacking.has(RK(sid)), '结果键不得被丢弃');
  // 实例复用切走再切回：首帧草稿还是上一会话的陈旧值（非空但 ≠backup/enhanced）⇒ 同样挂起
  const sidOther = 'audit-A5-other';
  b.render('别的会话草稿', 'plain', sidOther); // 复用实例切走（consume 基线随之切到 sidOther）
  b.render('上一会话的陈旧草稿', 'plain'); // 切回 audit-A5 的首帧：宿主尚未回灌，草稿是陈旧值
  assert.equal(s.phase, 'result', '切回首帧的陈旧草稿同样挂起（F1：prevSession 基线未建立）');
  assert.ok(h.lsBacking.has(RK(sid)), '陈旧草稿帧不得清结果键');
  b.render('原稿', 'plain'); // 第二帧才回灌原文 ⇒ 自动回注
  auditNote('AUDIT-05b', '第二帧回灌原文后 草稿写入=' + JSON.stringify(writes) + ' phase=' + s.phase + ' optimized=' + s.optimized + ' 链=' + s.memoryRounds.length);
  assert.deepEqual(writes, ['优化结果'], '回灌 backup ⇒ 回注暂存结果（修复核心）');
  assert.equal(s.phase, 'result');
});

// v4.2.3（F3·用户拍板）：清链（epoch 世代）后到达的在途结果 = **应用但不入链**——
// 草稿照常替换、optimized 照常置位，但链与澄清记录不复活。原 todo 待裁定项转正为回归断言。
test('AUDIT-06 在途 + 切档位: 清链后到达的在途结果应用但不入链（轨迹不复活）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'audit-A6';
  let settle = null;
  h.hostStub.respond = () => new Promise((r) => { settle = r; });
  const writes = [];
  const b = loadButton(h, sid, { inputActions: { setDraft: (v) => writes.push(v) } });
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: '早轮', output: '早结果' }]; s.optimized = true; h.api.saveMemoryStore(sid, s.memoryRounds);
  const el = b.render('新草稿', 'plain');
  mainBtnOf(el).props.onClick();
  assert.equal(s.phase, 'enhancing');
  h.api.applyModeSwitch(sid, 'expert'); // 在本会话切档 ⇒ 清链（chainEpoch +1）
  assert.deepEqual(s.memoryRounds, [], '清链先发生');
  settle({ ok: true, text: '在途结果' });
  await flush();
  auditNote('AUDIT-06', '在途结果到达后 写草稿=' + JSON.stringify(writes) + ' phase=' + s.phase + ' optimized=' + s.optimized
    + ' 链=' + s.memoryRounds.length + ' 链键=' + h.lsBacking.has(MK(sid)),
    'v4.2.3 语义：结果应用（草稿替换 + optimized）但不入链/不落键');
  assert.deepEqual(writes, ['在途结果'], '结果照常应用（用户拍板：应用但不入链）');
  assert.equal(s.phase, 'result');
  assert.equal(s.optimized, true, 'optimized 照常置位（结果已真实应用）');
  assert.equal(s.memoryRounds.length, 0, '被清掉的轨迹不得因在途结果而复活（epoch 守卫）');
  assert.equal(h.lsBacking.has(MK(sid)), false, '链键不得重现');
});

test('AUDIT-07 实例复用: 同一实例 A→B，B 的渲染只反映 B；A 的状态不被 B 的操作改动', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A7'; const sidB = 'audit-B7';
  const sA = h.api.storeFor(sidA);
  sA.phase = 'result'; sA.backup = 'A原稿'; sA.enhanced = 'A结果'; sA.optimized = true;
  sA.memoryRounds = [{ input: 'A原稿', output: 'A结果' }];
  const b = loadButton(h, sidA);
  const elA = b.render('A结果', 'plain');
  const textsA = collectText(mainBtnOf(elA));
  const auxA = auxGlyphOf(elA);
  const elB = b.render('B草稿', 'plain', sidB);
  const textsB = collectText(mainBtnOf(elB));
  auditNote('AUDIT-07', 'A 主键=' + JSON.stringify(textsA) + ' 副键=' + auxA + ' | B 主键=' + JSON.stringify(textsB) + ' 副键=' + JSON.stringify(auxGlyphOf(elB))
    + ' | A 状态 phase=' + sA.phase + ' enhanced=' + JSON.stringify(sA.enhanced) + ' 链=' + sA.memoryRounds.length);
  assert.ok(textsA.includes('result'), 'A：主键=撤销优化');
  assert.equal(auxA, '⟳', 'A：副键 = 从零重新优化');
  assert.ok(textsB.includes('✨'), 'B（首次态）：主键 = ✨ + 模式标签');
  assert.equal(auxBtnOf(elB), undefined, 'B 不得渲染副键');
  assert.equal(sA.phase, 'result', 'A 的状态不被 B 的渲染改动');
  assert.equal(sA.enhanced, 'A结果');
  assert.equal(sA.memoryRounds.length, 1);
});

// v4.2.3（F5·用户拍板）：optimized 持久化（dsh-enh-opt:<sid>）——回收行为维持（不抑制），
// 重建时经 opt 键恢复「已优化」态，「重新优化」入口不再退化为「首次」。原现状记录转正为修复断言。
test('AUDIT-09 卸载回收: idle+optimized（记忆关·结果已消费）⇒ store 回收，再进入经 opt 键恢复「已优化」态（F5 修复）', () => {
  const h = loadHelpers({ memory: false, mode: 'lite' });
  const sid = 'audit-A9';
  const s = h.api.storeFor(sid);
  s.phase = 'idle'; s.optimized = true; s.enhanced = ''; s.backup = '原稿'; s.memoryRounds = [];
  h.api.saveOptimizedStore(sid, true); // 真实流程由完成应用分支自动写入（见 AUDIT-16 全链路）
  h.api.releaseStoreIfIdle(sid);
  const again = h.api.storeFor(sid);
  auditNote('AUDIT-09', '回收后重建：同对象=' + (again === s) + ' optimized=' + again.optimized + ' phase=' + again.phase + ' 链=' + again.memoryRounds.length,
    'v4.2.3（F5）：optimized 经 dsh-enh-opt:<sid> 持久化——切走回收/刷新/重启后「重新优化」入口不退化');
  assert.notEqual(again, s, 'idle 且无监听者的 store 仍会被回收（修复走持久化，不抑制回收）');
  assert.equal(again.optimized, true, '修复：optimized 经 opt 键恢复（原行为：丢失退化为「首次」）');
});

test('AUDIT-10 并发会话·seq 隔离: A/B 各自 seq=1 在途，取消 B 不影响 A（host 按 (sessionId, seq) 定位）', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A10'; const sidB = 'audit-B10';
  h.hostStub.respond = () => new Promise(() => {}); // 两笔请求都保持挂起
  const bA = loadButton(h, sidA, { inputActions: { setDraft: () => {} } });
  mainBtnOf(bA.render('A 草稿', 'plain')).props.onClick();
  const bB = loadButton(h, sidB, { inputActions: { setDraft: () => {} } });
  mainBtnOf(bB.render('B 草稿', 'plain')).props.onClick();
  const sA = h.api.storeFor(sidA); const sB = h.api.storeFor(sidB);
  const seqA = sA.seq; const seqB = sB.seq;
  mainBtnOf(bB.render('B 草稿', 'plain')).props.onClick(); // enhancing 态点击 = 取消
  const cancels = h.hostStub.calls.filter((c) => c.method === 'cancel');
  const hostSrc = hostSrcOf();
  auditNote('AUDIT-10', 'seqA=' + seqA + ' seqB=' + seqB + ' cancel=' + JSON.stringify(cancels.map((c) => c.args))
    + ' | 取消后 A=' + sA.phase + ' B=' + sB.phase
    + ' | host 定位键=' + (hostSrc.includes('requestKey(sessionId, seq)') ? 'requestKey(sessionId, seq)' : '未找到'));
  assert.equal(cancels.length, 1, '只取消 B 一笔');
  assert.equal(cancels[0].args.sessionId, sidB);
  assert.equal(cancels[0].args.seq, seqB);
  assert.equal(sB.phase, 'idle', 'B 被取消');
  assert.equal(sA.phase, 'enhancing', 'A 的在途请求不受 B 的取消影响');
  assert.ok(hostSrc.includes('markAndAbort(requestKey(sessionId, seq)'), 'host cancel 必须按 (sessionId, seq) 定位');
  assert.ok(hostSrc.includes('pending.get(requestKey(sessionId, seq))'), 'host progress 必须按 (sessionId, seq) 定位');
});

test('AUDIT-12 跨会话·澄清态: A 澄清中切到 B，B 不得看到 A 的题；A 的题保留可续答', () => {
  const h = loadHelpers({ memory: true, mode: 'expert' });
  const sidA = 'audit-A12'; const sidB = 'audit-B12';
  const sA = h.api.storeFor(sidA);
  sA.phase = 'clarify'; sA.clarify = [{ q: 'A 的歧义', kind: 'ambiguity' }]; sA.backup = 'A 草稿';
  const b = loadButton(h, sidA);
  const elA = b.render('A 草稿', 'plain');
  const elB = b.render('B 草稿', 'plain', sidB);
  const sB = h.api.storeFor(sidB);
  auditNote('AUDIT-12', 'A clarify=' + sA.clarify.length + ' phase=' + sA.phase + ' 主键=' + JSON.stringify(collectText(mainBtnOf(elA)))
    + ' | B clarify=' + sB.clarify.length + ' phase=' + sB.phase + ' 主键=' + JSON.stringify(collectText(mainBtnOf(elB))));
  assert.ok(collectText(mainBtnOf(elA)).includes('btnClarify'), 'A：主键 = 等待作答');
  assert.equal(sB.phase, 'idle', 'B 不得继承 A 的澄清态');
  assert.deepEqual(sB.clarify, []);
  assert.deepEqual(collectText(mainBtnOf(elB)), ['✨', 'expert'], 'B：首次态主键');
  assert.equal(sA.phase, 'clarify', 'A 的澄清态保留');
  assert.equal(sA.clarify.length, 1);
});


// ================= 多会话隔离审核 · 第二批（v4.2.3 修复回归：F4/F5/F9/F10） =================
// 编号接续第一批（AUDIT-01…12）；处置决策与链路见 docs/audit-session-isolation.md、docs/plan-v4.5-decisions.md。

// v4.2.3（F9·审计处置）：结果消费收敛 helpers.consumeResult 后，bar/button 两份 effect 任意执行顺序
// 行为一致——瞬态帧挂起且键保留、真实编辑删键；残留键复活路径（store 重建后 phase 复活 result）断根。
test('AUDIT-13 消费 parity: bar/button 双挂载（两种执行顺序）——首帧挂起键保留、真实编辑删键、复活断根', () => {
  // 顺序①：bar 的 effect 先执行（生产环境由宿主槽位顺序决定，两种都必须等价）
  const h1 = loadHelpers({ memory: true, mode: 'standard' });
  const sid1 = 'audit-A13-bar-first';
  {
    const s = h1.api.storeFor(sid1);
    s.phase = 'result'; s.backup = '原稿'; s.enhanced = '结果'; s.optimized = true;
    h1.lsBacking.set(RK(sid1), JSON.stringify({ b: '原稿', e: '结果' }));
    const bar = loadBar(h1, sid1);
    const btn = loadButton(h1, sid1);
    bar.render(''); btn.render(''); // 双组件同帧首帧：空草稿
    assert.equal(s.phase, 'result', 'bar 先行：首帧空草稿挂起');
    assert.ok(h1.lsBacking.has(RK(sid1)), 'bar 先行：首帧不得删结果键');
    bar.render('用户编辑'); btn.render('用户编辑'); // 第二帧：真实编辑
    assert.equal(s.phase, 'idle', 'bar 先行：真实编辑消费');
    assert.equal(h1.lsBacking.has(RK(sid1)), false, 'bar 先行：消费必须删结果键（原 bar 版不删——F9 修复核心）');
    h1.api.releaseStoreIfIdle(sid1);
    assert.equal(h1.api.storeFor(sid1).phase, 'idle', '键已删 ⇒ store 重建后不得复活 result（复活路径断根）');
  }
  // 顺序②：button 先执行
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'audit-A13-btn-first';
  {
    const s = h2.api.storeFor(sid2);
    s.phase = 'result'; s.backup = '原稿'; s.enhanced = '结果'; s.optimized = true;
    h2.lsBacking.set(RK(sid2), JSON.stringify({ b: '原稿', e: '结果' }));
    const btn = loadButton(h2, sid2);
    const bar = loadBar(h2, sid2);
    btn.render(''); bar.render('');
    assert.equal(s.phase, 'result', 'button 先行：首帧空草稿挂起');
    assert.ok(h2.lsBacking.has(RK(sid2)), 'button 先行：首帧不得删结果键');
    btn.render('用户编辑'); bar.render('用户编辑');
    assert.equal(s.phase, 'idle', 'button 先行：真实编辑消费');
    assert.equal(h2.lsBacking.has(RK(sid2)), false, 'button 先行：消费删键');
  }
  auditNote('AUDIT-13', 'bar-first 与 btn-first 双顺序：挂起/删键行为一致（F9 修复验证）');
});

// v4.2.3（F10·审计处置）：config 订阅不再挂清链——启动期磁盘配置同步（或任何程序化 mode 跳变）
// 零清链；清链唯一入口 = applyModeSwitch（作用域断言见 MEM-06/AUDIT-03）。
test('AUDIT-14 启动同步/config 直改: 模式跳变不触发任何清链（F10 修复）', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A14a'; const sidB = 'audit-A14b';
  for (const sid of [sidA, sidB]) {
    const s = h.api.storeFor(sid);
    s.memoryRounds = [{ input: 'x', output: 'X' }]; s.optimized = true;
    h.api.saveMemoryStore(sid, s.memoryRounds);
  }
  h.lsBacking.set(MK('audit-A14-gone'), JSON.stringify([{ input: 'g', output: 'G' }]));
  // 模拟启动期 host 磁盘配置同步：config 整体替换 + 广播（loadHelpers 的 saveConfig 桩同语义）
  h.configState.value = Object.assign({}, h.configState.value, { mode: 'expert' });
  h.fireConfig(); // 旧实现此处触发 clearAllMemoryChains（F10 复现路径）
  auditNote('AUDIT-14', 'config 跳变广播后 A 链=' + h.api.storeFor(sidA).memoryRounds.length
    + ' B 链=' + h.api.storeFor(sidB).memoryRounds.length + ' 残键=' + h.lsBacking.has(MK('audit-A14-gone')),
    'v4.2.3：config-only 变化零清链（启动同步安全）');
  assert.equal(h.api.storeFor(sidA).memoryRounds.length, 1, '会话 A 的链保留');
  assert.equal(h.api.storeFor(sidB).memoryRounds.length, 1, '会话 B 的链保留');
  assert.ok(h.lsBacking.has(MK('audit-A14-gone')), '已释放会话残键保留');
});

// v4.2.3（F4·审计处置）：away 判定改实例本地 liveness——复用实例切走 ⇒ 不注入；
// liveness.current=null（发起实例已卸载）⇒ 不注入。不再依赖全局 activeSessionId 的挂载顺序。
test('AUDIT-15 实例本地 away: 复用实例切走 ⇒ 不注入；liveness=null（卸载）⇒ 不注入（F4 修复）', async () => {
  // ① 复用实例 A→B：A 的在途完成不注入（button 的 livenessRef.current 已随渲染指向 B）
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sidA = 'audit-A15a'; const sidB = 'audit-A15b2';
  let settle = null;
  h.hostStub.respond = () => new Promise((r) => { settle = r; });
  const writes = [];
  const b = loadButton(h, sidA, { inputActions: { setDraft: (v) => writes.push(v) } });
  mainBtnOf(b.render('A 草稿', 'plain')).props.onClick();
  b.render('B 草稿', 'plain', sidB); // 复用实例切走
  settle({ ok: true, text: 'A 结果' });
  await flush();
  assert.deepEqual(writes, [], '切走后 A 的结果只暂存不注入（实例本地判定）');
  assert.equal(h.api.storeFor(sidA).phase, 'result', '结果暂存待回');
  // ② 直调形态：liveness.current === null（发起组件已卸载）⇒ 不注入
  let settle2 = null;
  h.hostStub.respond = () => new Promise((r) => { settle2 = r; });
  const writes2 = [];
  h.api.enhance('audit-A15c', '草稿', { setDraft: (v) => writes2.push(v) }, { current: '草稿' }, undefined, undefined, { current: null });
  settle2({ ok: true, text: '结果C' });
  await flush();
  assert.deepEqual(writes2, [], 'liveness.current=null（实例已卸载）⇒ 不注入');
  auditNote('AUDIT-15', '复用切走注入=' + JSON.stringify(writes) + ' 卸载态注入=' + JSON.stringify(writes2) + '（均须为空）');
});

// v4.2.3（F5·用户拍板）：optimized 持久化全链路——完成 ⇒ 写 dsh-enh-opt 键；清链 ⇒ 复位并删键；
// 记忆关 + 结果已消费 + store 回收重建 ⇒ 经键恢复（原 AUDIT-09 现状缺陷的端到端回归）。
test('AUDIT-16 optimized 持久化全链路: 完成写键 → 回收重建恢复 → 清链删键（F5）', async () => {
  const h = loadHelpers({ memory: false, mode: 'lite' });
  const sid = 'audit-A16';
  const s = h.api.storeFor(sid);
  h.hostStub.respond = () => ({ ok: true, text: 'OUT' });
  h.api.enhance(sid, '草稿', { setDraft: () => {} }, { current: '草稿' });
  await flush();
  assert.equal(s.optimized, true, '完成应用置 optimized');
  assert.ok(h.lsBacking.has('dsh-enh-opt:' + sid), '完成应用分支必须写 opt 键（记忆关也写）');
  s.phase = 'idle'; s.enhanced = ''; // 结果已消费（挂起结果被真实编辑丢弃后的等价终态）
  h.api.releaseStoreIfIdle(sid);
  const again = h.api.storeFor(sid);
  assert.notEqual(again, s, '空闲 store 被回收');
  assert.equal(again.optimized, true, '回收重建后经 opt 键恢复（「重新优化」入口不退化）');
  // 清链三触发任一路径（此处直接走 clearMemoryChain）⇒ 复位 + 删键
  h.api.clearMemoryChain(sid);
  assert.equal(h.lsBacking.has('dsh-enh-opt:' + sid), false, '清链必须同步删 opt 键（新一轮从「首次」开始）');
  assert.equal(h.api.storeFor(sid).optimized, false);
  auditNote('AUDIT-16', '写键→回收重建恢复→清链删键 全链路 OK（F5）');
});
