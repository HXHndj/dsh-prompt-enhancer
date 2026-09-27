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
  const factory = new Function(
    'host', 'configState', 'localStorage', 'MEMORY_ROUNDS_MAX', 'SEEN_KEY_PREFIX', 'MEMORY_KEY_PREFIX', 'subscribeConfig',
    src + '\n;return { enhance, undo, cancelEnhance, clarifyCancel, guardPasses, setActiveSession, getActiveSession,'
      + ' storeFor, subscribe, notify, releaseStoreIfIdle, safeSetDraft, clearSeen, clearMemoryChain, clearAllMemoryChains,'
      + ' bindMemoryChainModeWatch, memoryKey, saveMemoryStore, resolveActualMode, splitCommand, errorKey };'
  );
  const api = factory(hostStub, configState, localStorageStub, MEMORY_ROUNDS_MAX_TEST, 'dsh-enh-seen:', 'dsh-enh-memory:', subscribeConfig);
  const fireConfig = () => { for (const fn of [...cfgListeners]) fn(); };
  return { api, hostStub, lsBacking, configState, fireConfig, subscribeConfig, localStorageStub };
}

// v4.1（D1 清链触发①）：EnhanceButton 的「草稿被清空」效应是 React effect——用迷你 React 运行时
//（useState/useRef/useEffect + deps 浅比较）驱动真实组件函数，不改组件代码即可断言跳变语义：
// 首屏草稿本就为空不得误清（D2 刷新保链），「非空 → 空」跳变（发送/手动清空）才清链。
function loadButton(helpers, sessionId) {
  const src = decodeChunk('src/client/components/enhance-button.js');
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
    'React', 'makeT', 'subscribe', 'subscribeConfig', 'storeFor', 'notify', 'releaseStoreIfIdle', 'setActiveSession',
    'getActiveSession', 'safeSetDraft', 'setLastDraft', 'guardPasses', 'modeShortLabel', 'configState', 'EnhanceMenu',
    'clarifyCancel', 'enhance', 'host', 'clearMemoryChain', 'clearSeen', 'cancelEnhance', 'errorKey', 'undo',
    src + '\n;return EnhanceButton;'
  );
  const EnhanceButton = factory(
    React, (p) => (p && typeof p.t === 'function' ? p.t : t), helpers.api.subscribe, helpers.subscribeConfig,
    helpers.api.storeFor, helpers.api.notify, helpers.api.releaseStoreIfIdle, helpers.api.setActiveSession,
    helpers.api.getActiveSession, helpers.api.safeSetDraft, noop, helpers.api.guardPasses, (tt, mode) => mode,
    helpers.configState, () => null, helpers.api.clarifyCancel, helpers.api.enhance, helpers.hostStub,
    helpers.api.clearMemoryChain, helpers.api.clearSeen, helpers.api.cancelEnhance, (code) => code, helpers.api.undo
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
    'React', 'makeT', 'subscribe', 'storeFor', 'notify', 'releaseStoreIfIdle', 'errorKey',
    src + '\n;return EnhanceBar;'
  );
  const EnhanceBar = factory(
    React, (p) => (p && typeof p.t === 'function' ? p.t : t), helpers.api.subscribe,
    helpers.api.storeFor, helpers.api.notify, helpers.api.releaseStoreIfIdle, helpers.api.errorKey
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

// ---------- v4.0.0 专家档澄清卡：clarify 分支（信号/提交/跳过/取消四路 + 记忆链并入） ----------
test('ENH-CLARIFY signal: 澄清信号 → phase=clarify + 题目入 store + 不写草稿/不置 optimized/backup 保留', async () => {
  const { api, hostStub, lsBacking } = loadHelpers();
  const sid = 'sess-cl';
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  assert.ok(bar.includes("enhance(sessionId, draftRef.current, inputActions, draftRef, { answers: picked })"), '提交按钮必须带 answers 重调 enhance');
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
  h.api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  api.setActiveSession(sid2);
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
  api.setActiveSession(sid3);
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
  api.setActiveSession(sid);
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

test('MEM-06 clear②切换模式: config.mode 跳变（设置页下拉 / ▾ 菜单两入口）→ 清链 + 删键（含已释放会话残键）；同值重选不清、草稿/结果态不动', () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-mode';
  const s = h.api.storeFor(sid);
  s.memoryRounds = [{ input: 'm', output: 'M' }];
  s.optimized = true;
  s.phase = 'result';
  s.backup = 'm';
  s.enhanced = 'M';
  h.api.saveMemoryStore(sid, s.memoryRounds);
  // 已释放 store 的会话（切走后 releaseStoreIfIdle 回收了内存条目）只剩 localStorage 残键
  h.lsBacking.set(MK('sess-gone'), JSON.stringify([{ input: 'g', output: 'G' }]));
  h.configState.value.mode = 'standard'; // 同值重选
  h.fireConfig();
  assert.equal(h.api.storeFor(sid).memoryRounds.length, 1, '同值重选不算「切换模式」→ 不清链');
  h.configState.value.mode = 'expert'; // 真切换（两入口都只经 saveConfig 写 config.mode）
  h.fireConfig();
  const after = h.api.storeFor(sid);
  assert.deepEqual(after.memoryRounds, [], 'D1：切换优化模式 → 清链');
  assert.equal(after.optimized, false, '§2.2：切模式同时复位 optimized');
  assert.equal(h.lsBacking.has(MK(sid)), false, '清链删持久化键');
  assert.equal(h.lsBacking.has(MK('sess-gone')), false, '已释放会话的 dsh-enh-memory:* 残键一并清扫');
  assert.equal(after.phase, 'result', '§2.2：切模式只清链——不动结果态');
  assert.equal(after.enhanced, 'M', '§2.2：切模式不动结果（草稿/结果态保持原样）');
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

test('MEM-07 undo(保持 D5): 撤销只弹最近一轮并同步持久化（否则刷新复活已撤回轮）', async () => {
  const { api, hostStub, lsBacking } = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-undo';
  api.setActiveSession(sid);
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: 'd1' };
  let n = 0;
  hostStub.respond = () => ({ ok: true, text: 'O' + (++n) });
  api.enhance(sid, 'd1', inputActions, draftRef);
  await flush();
  draftRef.current = 'd2';
  api.enhance(sid, 'd2', inputActions, draftRef);
  await flush();
  assert.equal(api.storeFor(sid).memoryRounds.length, 2);
  api.undo(sid, inputActions);
  const s = api.storeFor(sid);
  assert.deepEqual(s.memoryRounds, [{ input: 'd1', output: 'O1' }], 'D5：撤销语义不变——只弹最近一轮');
  assert.deepEqual(JSON.parse(lsBacking.get(MK(sid))), s.memoryRounds, '弹出后同步持久化键');
  assert.equal(s.optimized, false, '撤销复位 optimized');
});

test('MEM-08 zero-answer(§2.7): 带 answers 但一题未答 → 按 skip 重跑，绝不发「既无 answers 又无 skip」的请求', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
  const sid = 'sess-zero';
  api.setActiveSession(sid);
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
    h.api.setActiveSession(sid);
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
  api.setActiveSession(sid);
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
  // v4.1 记忆链持久化/清链接线（与结果键独立）
  for (const marker of [
    'function memoryKey(sessionId) { return MEMORY_KEY_PREFIX + sessionId; }',
    'saveMemoryStore(sessionId, s.memoryRounds);',
    'clearMemoryStore(sessionId);',
    'sweepMemoryStoreKeys();',
  ]) {
    assert.ok(h.includes(marker), 'helpers 缺记忆链持久化接线标记: ' + marker);
  }
});

// v4.1 清链三触发接线契约（行为级用例见 MEM-04~06）
test('MEM wiring: 清链三触发的接线标记（草稿跳变 + 切模式监听 + 澄清不入链）', () => {
  const btn = decodeChunk('src/client/components/enhance-button.js');
  const h = decodeChunk('src/client/helpers.js');
  const i18n = decodeChunk('src/client/i18n.js');
  // ① 草稿被清空：发送与手动清空统一为 trim 空 + 「非空→空」跳变（首屏空草稿不得误清 → D2）
  assert.ok(btn.includes('const prevDraftRef = React.useRef('), '缺草稿跳变基线 ref');
  assert.ok(btn.includes("const emptied = !sessionChanged && prev.trim() !== ''"), '缺「同会话内 非空→空」跳变判定');
  assert.ok(btn.includes('const prevSessionRef = React.useRef(sessionId)'), '缺会话基线（复用实例换 sessionId 时不得误清）');
  assert.ok(btn.includes('if (emptied || sendSeenRef.current === true)'), '缺统一清链门（发送与手动清空同口径）');
  assert.ok(btn.includes('clearMemoryChain(sessionId)'), '清链必须走 helpers.clearMemoryChain');
  // ② 切模式：helpers 装载时绑定 config.mode 监听（设置页下拉与 ▾ 菜单两入口都只经 saveConfig 写 mode）
  assert.ok(h.includes('bindMemoryChainModeWatch();'), 'helpers 装载时必须绑定模式监听');
  assert.ok(h.includes('clearAllMemoryChains();'), '切模式必须清全部会话的链（含已释放会话残键）');
  assert.ok(h.includes('if (next === memoryChainModeSeen) return;'), '同值重选不得清链');
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
test('ENH-FLOW wiring: 空输入主键 = 可点击开增强设置（禁用态退役；置灰观感与 ▾ 菜单保留）', () => {
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
  assert.ok(btn.includes('dsh-enh-btn-empty'), '空输入仍须携带置灰类（styles 已定义 .dsh-enh-btn-empty）');
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
  assert.ok(menu.includes('MODE_PARAMS_DEFAULT[next]'), '切模式必须重置该档默认运行参数（与设置页同语义）');
  assert.equal(menu.includes('MODE_BUDGET_DEFAULT'), false, 'MODE_BUDGET_DEFAULT 已随预算全局化删除，不得回流');
  assert.ok(/mode: next,[\s\S]{0,400}params: \{/.test(menu), '切模式必须经 saveConfig 单点写入 mode + params');
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

test('V4 按钮三态: 首次 → ✨+模式标签；未改草稿 → 重新优化；已修改 → 继续优化；改回原样 → 重新优化', async () => {
  const h = loadHelpers({ memory: true, mode: 'standard' });
  const sid = 'sess-tri';
  const btn = loadButton(h, sid);
  // 首次：无 btnContinue/btnRedo（✨ + 模式短标签态）
  let texts = collectText(btn.render('草稿', 'plain'));
  assert.equal(texts.includes('btnContinue'), false, '首次优化不得显示继续优化');
  assert.equal(texts.includes('btnRedo'), false, '首次优化不得显示重新优化');
  // 优化成功（结果 OUT 写回草稿）
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUT' });
  h.api.enhance(sid, '草稿', inputActions, draftRef);
  await flush();
  // 优化成功后 phase='result'（撤销态）——一次「草稿≠enhanced/backup」的 render 让 effect 置回 idle
  h.api.storeFor(sid).phase = 'idle'; // 优化成功后置 result（撤销态）——脱离后按钮回到空闲三态
  // 未改草稿（= 最近优化结果正文）→ 重新优化
  texts = collectText(btn.render('OUT', 'plain'));
  assert.ok(texts.includes('btnRedo'), 'v4.4（V4）：草稿与最近优化结果逐字节一致 → 重新优化');
  assert.equal(texts.includes('btnContinue'), false, '未改草稿不得显示继续优化');
  // 修改草稿 → 继续优化
  texts = collectText(btn.render('OUT 改', 'plain'));
  assert.ok(texts.includes('btnContinue'), 'v4.4（V4）：草稿已修改 → 继续优化');
  assert.equal(texts.includes('btnRedo'), false, '已修改不得显示重新优化');
  // 改回原样（逐字节一致）→ 重新优化（与 host 行级 diff 同源：差异段为空 ⟺ 严格相等）
  texts = collectText(btn.render('OUT', 'plain'));
  assert.ok(texts.includes('btnRedo'), '改回原文 → 重新优化');
  // 斜杠命令：前缀剥离后对比（/deploy OUT vs output=OUT → 重新优化）
  texts = collectText(btn.render('/deploy OUT', 'plain'));
  assert.ok(texts.includes('btnRedo'), '斜杠命令按正文对比（前缀不参与判定）');
  // undo → 回到首次态（undo 仅在 result 态生效，手动置回）
  h.api.storeFor(sid).phase = 'result';
  h.api.undo(sid, { setDraft: () => {} });
  texts = collectText(btn.render('草稿', 'plain'));
  assert.equal(texts.includes('btnRedo'), false, 'undo 后回到首次态（optimized 复位）');
});

test('V4 按钮三态·无链回退: 记忆关的 lite/standard 以最近结果正文为基准（改了 → 继续；没改 → 重新）', async () => {
  const h = loadHelpers({ memory: false, mode: 'standard' });
  const sid = 'sess-noredo';
  const btn = loadButton(h, sid);
  const inputActions = { setDraft: () => {} };
  const draftRef = { current: '草稿' };
  h.hostStub.respond = () => ({ ok: true, text: 'OUT2' });
  h.api.enhance(sid, '草稿', inputActions, draftRef);
  await flush();
  assert.deepEqual(h.api.storeFor(sid).memoryRounds, [], '记忆关 → 不写链');
  h.api.storeFor(sid).phase = 'idle'; // 脱离 result 态（见 V4 主用例注释）
  let texts = collectText(btn.render('OUT2', 'plain'));
  assert.ok(texts.includes('btnRedo'), '无链回退 s.enhanced 剥前缀：未改 → 重新优化');
  texts = collectText(btn.render('OUT2 改', 'plain'));
  assert.ok(texts.includes('btnContinue'), '无链：已修改 → 继续优化');
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
  // ③ 三触发之二：切模式 → 全会话清除（含残键）
  const h2 = loadHelpers({ memory: true, mode: 'standard' });
  const sid2 = 'sess-clr-mode';
  const s2 = h2.api.storeFor(sid2);
  s2.clarifyAnswers = [{ q: 'Q', a: 'a', via: 'custom' }];
  h2.lsBacking.set(CK(sid2), JSON.stringify(s2.clarifyAnswers));
  h2.lsBacking.set(CK('sess-gone-clr'), JSON.stringify([{ q: 'G', a: 'g', via: 'custom' }]));
  h2.configState.value.mode = 'expert';
  h2.fireConfig();
  assert.equal(h2.lsBacking.has(CK(sid2)), false, '切模式清除本会话澄清键');
  assert.equal(h2.lsBacking.has(CK('sess-gone-clr')), false, '切模式清扫已释放会话的澄清残键');
  assert.deepEqual(h2.api.storeFor(sid2).clarifyAnswers, [], '切模式清内存澄清记录');
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
