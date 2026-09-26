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

function loadHelpers(configValue) {
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
    src + '\n;return { enhance, undo, cancelEnhance, clarifyCancel, guardPasses, setActiveSession, getActiveSession, storeFor };'
  );
  const api = factory(hostStub, { value: configValue || { memory: false } }, localStorageStub, 4, 'dsh-enh-seen:');
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

test('ENH-CLARIFY submit: 提交 → 带 answers 重调 + 终稿应用 + 澄清问答先于终稿写入 memoryRounds', async () => {
  const { api, hostStub } = loadHelpers({ memory: true, mode: 'expert' });
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
  // 提交（仅回答 Q1，Q2 保持原文开放性）→ 带 answers 重调
  api.enhance(sid, '草稿', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a' }] });
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls.length, 2, '必须重调 enhance');
  assert.deepEqual(enhanceCalls[1].args.answers, [{ q: 'Q1', a: 'a' }], '第二跳必须携带 answers');
  assert.equal(enhanceCalls[1].args.skip, undefined, '提交路径不得携带 skip');
  assert.equal(writes[writes.length - 1], '终稿', '终稿必须写回草稿');
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.equal(s.optimized, true);
  assert.deepEqual(s.memoryRounds, [
    { input: 'Q1', output: 'a' },
    { input: '草稿', output: '终稿' },
  ], '澄清问答先于终稿入链（继续优化不重复问）');
  assert.deepEqual(s.clarify, [], '终稿到达后旧题目必须清空');
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
  api.enhance(sid, '草稿M', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a' }] }); // 第 2 跳 → clarify 轮 2
  await flush();
  assert.equal(api.storeFor(sid).phase, 'clarify', '第二轮仍是澄清');
  api.enhance(sid, '草稿M', inputActions, draftRef, { answers: [{ q: 'Q2', a: 'c' }] }); // 第 3 跳 → 终稿
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.deepEqual(
    enhanceCalls[2].args.answers,
    [{ q: 'Q1', a: 'a' }, { q: 'Q2', a: 'c' }],
    '第三跳必须携带合并后的全部问答（前轮不丢，证据正文可见）'
  );
  const s = api.storeFor(sid);
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.memoryRounds, [
    { input: 'Q1', output: 'a' },
    { input: 'Q2', output: 'c' },
    { input: '草稿M', output: '两轮终稿' },
  ], '两轮问答都必须先于终稿入链（继续优化不重复问）');
});

test('ENH-CLARIFY skip keeps staged: 第二轮改跳过 → 不带 answers 带 skip，但前轮问答仍入链', async () => {
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
    return { ok: true, text: '跳过终稿K' };
  };
  api.enhance(sid, '草稿K', inputActions, draftRef);
  await flush();
  api.enhance(sid, '草稿K', inputActions, draftRef, { answers: [{ q: 'Q1', a: 'a' }] });
  await flush();
  api.enhance(sid, '草稿K', inputActions, draftRef, { skip: true }); // 第二轮跳过
  await flush();
  const enhanceCalls = hostStub.calls.filter((c) => c.method === 'enhance');
  assert.equal(enhanceCalls[2].args.skip, true, '第三跳必须携带 skip:true');
  assert.equal(enhanceCalls[2].args.answers, undefined, '跳过路径不携带 answers');
  const s = api.storeFor(sid);
  assert.deepEqual(s.memoryRounds, [
    { input: 'Q1', output: 'a' },
    { input: '草稿K', output: '跳过终稿K' },
  ], 'skip 不清已暂存问答——前轮 Q1 仍入链（不否决前轮已答）');
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
  assert.deepEqual(s.memoryRounds, [
    { input: 'Q4a', output: 'a4' },
    { input: 'Q4b', output: 'b4' },
    { input: 'Q4c', output: 'c4' },
    { input: '草稿9', output: '终稿9' },
  ], 'memoryRounds 受 MEMORY_ROUNDS_MAX=4 截断（计划二.2 保留项）：链保留最近 3 问答 + 终稿');
});

test('ENH-CLARIFY cap9 合同: host answers 上限必须为合计口径 slice(-9)，与 client 封顶对齐', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src/host/enhance-handlers.js'), 'utf8');
  const hostSrc = JSON.parse('"' + host.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*$/)[1] + '"');
  assert.ok(
    /\.map\(\(x\) => \(\{ q: String\(x\.q\), a: String\(x\.a\) \}\)\)\s*\n\s*\.slice\(-9\)/.test(hostSrc),
    'host answers 必须为合计口径 slice(-9)（旧 slice(0,3) 会把后轮新答案截出证据正文，违背 §三.2c）'
  );
  const h = decodeChunk('src/client/helpers.js');
  assert.ok(h.includes('.concat(roundAnswers).slice(-9)'), 'client 暂存必须同口径封顶 9（保留最近），与 host 对齐');
});

test('ENH-CLARIFY wiring: ClarifyPanel 挂 dock 槽位 + 主键 clarify 态 + i18n ZH/EN 成对', () => {
  const bar = decodeChunk('src/client/components/enhance-bar.js');
  const btn = decodeChunk('src/client/components/enhance-button.js');
  const app = decodeChunk('src/client/app.js');
  const i18n = decodeChunk('src/client/i18n.js');
  assert.ok(bar.includes('function ClarifyPanel'), 'bar chunk 缺 ClarifyPanel 组件');
  assert.ok(bar.includes("enhance(sessionId, draftRef.current, inputActions, draftRef, { answers: qa })"), '提交按钮必须带 answers 重调 enhance');
  assert.ok(bar.includes('{ skip: true }'), '跳过按钮必须带 skip:true 重调');
  assert.ok(bar.includes('clarifyCancel(sessionId, inputActions)'), '取消按钮必须走 clarifyCancel');
  assert.ok(bar.includes("t('clarifySubmit')") && bar.includes("t('clarifySkip')") && bar.includes("t('cancel')"), '三按钮（提交并继续/跳过直接优化/取消）缺一不可');
  assert.ok(bar.includes("type: 'radio'") && bar.includes("type: 'text'"), '每题必须渲染 radio 选项 + 自由输入框');
  // v4.0.1（评审修复·阻断）：槽位组件常驻挂载（不 clarify 时渲染 null 不卸载）——答案必须按轮
  // 渲染期同步（questions 引用变化即重置），不得依赖只在首挂载求值的 useState 惰性初始化
  assert.equal(/React\.useState\(\(\) =>\s*[\s\S]{0,80}clarify\.map/.test(bar), false, 'answers 不得再用惰性初始化（首挂载 phase 恒 idle → 恒空数组，作答失效）');
  assert.ok(bar.includes('roundRef.current = questions') && bar.includes("questions ? questions.map(() => '') : []"), 'answers 必须按轮渲染期同步（换轮/扩容重置）');
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

