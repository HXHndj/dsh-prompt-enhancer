'use strict';
// M2: bundle smoke test — evaluate the generated plugin-host.js with a mock
// harness + ctx (same mechanism as lib/index.cjs: new Function('harness', BODY))
// and verify RPC registration plus fast-path behavior. This is the first
// direct test of the generated bundle's runtime surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BODY = fs.readFileSync(path.join(__dirname, '..', 'plugin-host.js'), 'utf8');

function boot(opts) {
  const handlers = new Map();
  const harness = {
    handle(method, fn) {
      if (typeof method === 'string' && typeof fn === 'function') handlers.set(method, fn);
    },
    probeEnv() {
      return null;
    },
  };
  // apply() directly executes: ctx.get('llm'), handler registration, ctx.effect.
  // All deep paths (timer, sessions, sandboxPolicy, web...) are only touched
  // inside handlers, so a minimal mock keeps the fast paths testable.
  // opts.llm injects a fake llm service to exercise the full enhance pipeline.
  const ctx = {
    get: (name) => {
      if (name === 'llm' && opts && opts.llm) return opts.llm;
      if (name === 'sessionQuery' && opts && opts.sessionQuery) return opts.sessionQuery;
      if (name === 'sandboxPolicy' && opts && opts.sandboxPolicy) return opts.sandboxPolicy;
      if (name === 'fs' && opts && opts.fs) return opts.fs;
      if (name === 'web' && opts && opts.web) return opts.web;
      return undefined;
    },
    effect: () => {},
    // v3.1.3（看门狗）：默认 timer 不触发（既有测试不依赖定时器）；看门狗用例传 opts.timer 注入真实定时器
    timer: (opts && opts.timer) ? opts.timer : { timeout: () => () => {} },
  };
  const plugin = new Function('harness', BODY)(harness);
  if (typeof plugin.apply !== 'function') throw new Error('plugin.apply missing from bundle');
  plugin.apply(ctx);
  return { handlers };
}

// Fake llm service: records every stream() request, returns a one-delta
// successful stream (text-delta "OK" then finish stop).
function mockLlm(seen) {
  return {
    stream(params) {
      seen.push(params);
      return {
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            async next() {
              step += 1;
              if (step === 1) return { done: false, value: { type: 'text-delta', text: 'OK' } };
              return { done: false, value: { type: 'finish', reason: { kind: 'stop' } } };
            },
          };
        },
      };
    },
  };
}

test('SMK-01 bundle registers core RPC handlers', () => {
  const { handlers } = boot();
  const expected = [
    'enhance', 'enhance/progress', 'cancel', 'template/default', 'logs/last',
    'models/list', 'models/test', 'models/autochain', 'plugins/inventory',
  ];
  for (const method of expected) {
    assert.ok(handlers.has(method), 'missing handler: ' + method);
  }
});

test('SMK-02 enhance GUARD fast path (empty / command input)', async () => {
  const { handlers } = boot();
  const empty = await handlers.get('enhance')({ sessionId: 's', seq: 1, text: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'GUARD');
  const command = await handlers.get('enhance')({ sessionId: 's', seq: 2, text: '/help me' });
  assert.equal(command.ok, false);
  assert.equal(command.code, 'GUARD');
});

test('SMK-03 enhance NO_LLM fast path (mock ctx has no llm service)', async () => {
  const { handlers } = boot();
  const out = await handlers.get('enhance')({ sessionId: 's', seq: 1, text: 'hello' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_LLM');
});

test('SMK-04 enhance/progress returns NO_RECORD for unknown request', async () => {
  const { handlers } = boot();
  const out = await handlers.get('enhance/progress')({ sessionId: 'missing', seq: 42 });
  assert.deepEqual(out, { ok: false, code: 'NO_RECORD' });
});

// M3 fix：校验层 schema 必须与真实 client payload 形状对齐——client 调 enhance 传
// {sessionId, seq, text, config, mode}（helpers.js），handler 读 args.text；
// 此前 schema 误用 draft 字段导致全部 enhance 请求被 400 拦截（lib/index.cjs 分发前校验）。
test('SMK-05 RPC schema accepts real client payload shapes', () => {
  const { validateRpcArgs } = require('../lib/rpc-schema.cjs');
  // 真实 client 形状（helpers.js enhance 调用）
  assert.equal(validateRpcArgs('enhance', { sessionId: 's', seq: 1, text: 'draft body', config: {}, mode: 'base' }).ok, true);
  // 真实 client 形状（updater-card doCheck）
  assert.equal(validateRpcArgs('update/check', { repo: 'Fishsb/dsh-prompt-enhancer', sessionId: 's', tagsPayload: '[]', releasePayload: '{}' }).ok, true);
  // 真实 client 形状（model-main runTest）
  assert.equal(validateRpcArgs('models/test', { provider: 'p', model: 'm' }).ok, true);
  // 真实 client 形状（plugins-section act）
  assert.equal(validateRpcArgs('plugins/run', { sessionId: 's', pluginId: 'p', packageId: 'x', mode: 'run' }).ok, true);
  // 防回归：缺 text 应被拒
  assert.equal(validateRpcArgs('enhance', { sessionId: 's', draft: 'x' }).ok, false);
});

// v2.9.0-fix：reasoning（带 effort）链节自动放宽 maxTokens（>=8000）——
// 思考过程消耗输出预算，配置的 2000 在长输入 + effort=max 时耗尽 → 空流。
test('SMK-06 reasoning link auto-widens maxTokens', async () => {
  const seen = [];
  const { handlers } = boot({ llm: mockLlm(seen) });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm', reasoning: { enabled: true, effort: 'max' } }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reasoningEffort, 'max');
  assert.equal(seen[0].maxTokens, 8000);
});

test('SMK-07 non-reasoning link keeps configured maxTokens', async () => {
  const seen = [];
  const { handlers } = boot({ llm: mockLlm(seen) });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].maxTokens, 2000);
});

// ---- v4.0.0 三档重构：直发管道 + 专家档澄清信号集成测试 ----

function streamOf(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true };
        },
      };
    },
  };
}

// v3.1.3（看门狗 + 延迟连通性预检）：可编程 llm mock——
// probe（system 含 'connectivity probe'）：probeFail ? QUOTA finish : OK；
// 生成流：model === hangModel → 可中断挂起流（return() 可解挂）；否则 OK。
function mockLlmProbe(seen, opts) {
  const o = opts || {};
  const okStream = (text) => streamOf([
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const hangStream = () => {
    let resolveNext = null;
    return {
      [Symbol.asyncIterator]() {
        return {
          next() { return new Promise((resolve) => { resolveNext = resolve; }); },
          return() { if (resolveNext) resolveNext({ done: true }); return Promise.resolve({ done: true }); },
        };
      },
    };
  };
  return {
    stream(params) {
      seen.push(params);
      const sys = typeof params.system === 'string' ? params.system : '';
      if (sys.includes('connectivity probe')) {
        return o.probeFail
          ? streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'model quota exceeded' } } }])
          : okStream('PING');
      }
      if (params.model === o.hangModel) return hangStream();
      return okStream('ENH');
    },
  };
}

// v4.0.0：三档均无检索——单次主调用直发；sessionQuery 若被读取即失败（防检索回流）。
test('SMK-08 three modes go direct: single LLM call, no session reads, evidence JSON wraps draft', async () => {
  for (const mode of ['lite', 'standard', 'expert']) {
    const seen = [];
    const thrower = (name) => async () => { throw new Error('sessionQuery.' + name + ' must not be called (v4.0.0 removed retrieval)'); };
    const guardSession = { readSurface: thrower('readSurface'), listEvents: thrower('listEvents'), filterEvents: thrower('filterEvents') };
    const { handlers } = boot({ llm: mockLlm(seen), sessionQuery: guardSession });
    const out = await handlers.get('enhance')({
      sessionId: 's',
      seq: 1,
      text: '帮我优化登录提示词',
      config: { mode, fallback: [{ provider: 'p', model: 'm' }], params: { maxTokens: 2000, timeoutMs: 30000 } },
    });
    assert.equal(out.ok, true, mode);
    assert.equal(seen.length, 1, mode + ': single direct LLM call');
    const mainText = seen[0].messages[seen[0].messages.length - 1].content[0].text;
    assert.ok(mainText.includes('originalDraft'), mode + ': draft wrapped as evidence JSON');
    assert.ok(mainText.includes('帮我优化登录提示词'), mode + ': draft text present');
  }
});

test('SMK-08b continuation skips retrieve and uses delta as main direction', async () => {
  const seen = [];
  const { handlers } = boot({ llm: mockLlm(seen) });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 7,
    text: '旧优化结果 新增加要求',
    config: {
      mode: 'lite',
      memory: true,
      fallback: [{ provider: 'p', model: 'm' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
    memory: { rounds: [{ input: '旧需求', output: '旧优化结果' }] },
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 1, 'continuation should only call main LLM, no judge/retrieval');
  assert.ok(seen[0].system.includes('继续优化模式'), 'system should include CONTINUE_PROMPT');
  const messages = seen[0].messages;
  const finalText = messages[messages.length - 1].content[0].text;
  assert.ok(finalText.includes('【本轮修改】（主要优化方向）'), 'finalText should lead with delta direction');
  assert.ok(finalText.includes('旧优化结果'), 'current draft should be included');
});


// v4.0.0：可编程 llm mock——按脚本顺序返回固定文本流。
function mockLlmScripted(seen, script) {
  let i = 0;
  return {
    stream(params) {
      seen.push(params);
      const text = script[Math.min(i, script.length - 1)];
      i += 1;
      return streamOf([
        { type: 'text-delta', text },
        { type: 'finish', reason: { kind: 'stop' } },
      ]);
    },
  };
}

// v4.0.0：专家档澄清往返——首段输出澄清 JSON（含 ```json 围栏）→ 响应携带 clarify 无正文；
// 带 answers 的第二次调用生成终稿，答复并入证据正文；skip 跳过分支把标记写入证据正文。
test('SMK-16 expert clarify roundtrip: signal → answers → final draft (skip too)', async () => {
  const clarifyJson = '```json\n{"clarify": true, "questions": [{"q": "「它」指哪个函数？", "options": ["parseConfig", "loadPlugins"]}]}\n```';
  const seen = [];
  const { handlers } = boot({ llm: mockLlmScripted(seen, [clarifyJson, '终稿文本']) });
  const base = {
    sessionId: 's',
    config: { mode: 'expert', fallback: [{ provider: 'p', model: 'm' }], params: { maxTokens: 4000, timeoutMs: 60000 } },
  };
  const r1 = await handlers.get('enhance')({ ...base, seq: 1, text: '把它改成异步的，别影响调用' });
  assert.equal(r1.ok, true);
  assert.ok(Array.isArray(r1.clarify) && r1.clarify.length === 1, 'fenced clarify JSON parsed');
  assert.equal(r1.clarify[0].options.length, 2, 'options normalized');
  assert.equal(r1.text, '', 'no final text in clarify response');
  const r2 = await handlers.get('enhance')({
    ...base,
    seq: 2,
    text: '把它改成异步的，别影响调用',
    answers: [{ q: '「它」指哪个函数？', a: 'loadPlugins' }],
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.text, '终稿文本');
  assert.equal(r2.clarify, undefined, 'final call carries no clarify');
  const finalText2 = seen[1].messages[seen[1].messages.length - 1].content[0].text;
  assert.ok(finalText2.includes('clarifyAnswers'), 'answers enter the evidence JSON');
  assert.ok(finalText2.includes('loadPlugins'), 'answered option present in evidence');
  const r3 = await handlers.get('enhance')({
    ...base,
    seq: 3,
    text: '把它改成异步的，别影响调用',
    skip: true,
  });
  assert.equal(r3.ok, true);
  const finalText3 = seen[2].messages[seen[2].messages.length - 1].content[0].text;
  assert.ok(finalText3.includes('"skipped":true'), 'skip flag enters the evidence JSON');
});

// v4.0.0：澄清信号仅专家档生效——standard 档输出同款 JSON 一律按正文处理。
test('SMK-17 clarify signal is expert-only', async () => {
  const seen = [];
  const { handlers } = boot({ llm: mockLlmScripted(seen, ['{"clarify": true, "questions": [{"q": "?", "options": ["a", "b"]}]}']) });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '随便优化一下',
    config: { mode: 'standard', fallback: [{ provider: 'p', model: 'm' }], params: { maxTokens: 2000, timeoutMs: 30000 } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.clarify, undefined, 'standard mode must not branch into clarify');
  assert.equal(typeof out.text, 'string');
  assert.notEqual(out.text, '');
});

// ---- v3.1.3 看门狗 + 延迟连通性预检（base 模式直通 llm，无检索干扰） ----
const REAL_TIMER = { timeout: (cb, ms) => { const id = setTimeout(cb, ms); return () => clearTimeout(id); } };
const WATCHDOG_WAIT = 15600; // 参考值（当前未消费）：略大于 bundle 内 WATCHDOG_TIMEOUT_MS=15000（v3.3.3）

// SMK-17：首条生成流静默挂起（看门狗 3s 触发）→ 探测剩余链 → 第二条可达 → 用第二条生成成功
test('SMK-17 watchdog: silent head → probe next → fallback generation (fallbackUsed)', async () => {
  const seen = [];
  const { handlers } = boot({
    llm: mockLlmProbe(seen, { hangModel: 'm-a' }),
    timer: REAL_TIMER,
  });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm-a' }, { provider: 'p', model: 'm-b' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'm-b', '由探测选中的第二条模型完成');
  assert.equal(out.fallbackUsed, true, '非首个模型完成 → fallbackUsed');
  // 调用序列：m-a 生成（挂起）→ 探测 m-b → m-b 生成
  const gen = seen.filter((p) => !String(p.system || '').includes('connectivity probe'));
  const probe = seen.filter((p) => String(p.system || '').includes('connectivity probe'));
  assert.equal(gen[0].model, 'm-a', '首条尝试是 m-a');
  assert.equal(gen[1].model, 'm-b', '重启生成用 m-b');
  assert.equal(probe.length, 1, '仅探测一条');
  assert.equal(probe[0].model, 'm-b');
});

// SMK-18：首条挂起 + 剩余链探测全失败 + 回头探首条也失败 → 立即 ALL_MODELS_UNAVAILABLE
test('SMK-18 watchdog: all probes fail → ALL_MODELS_UNAVAILABLE fast', async () => {
  const seen = [];
  const t0 = Date.now();
  const { handlers } = boot({
    llm: mockLlmProbe(seen, { hangModel: 'm-a', probeFail: true }),
    timer: REAL_TIMER,
  });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm-a' }, { provider: 'p', model: 'm-b' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  const elapsed = Date.now() - t0;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ALL_MODELS_UNAVAILABLE');
  // v3.3.3（常量放大适配）：WATCHDOG_TIMEOUT_MS 5000→15000——挂起首条需等满看门狗窗口
  // 才进入探测（探测本身毫秒级返回 QUOTA 失败），故窗口从 <15s 放宽到 <25s（30s 总超时内）
  assert.ok(elapsed < 25000, '看门狗窗口内报错（远小于 30s 总超时），实际 ' + elapsed + 'ms');
  // 探测了两条（m-b 失败后回头探 m-a）
  const probe = seen.filter((p) => String(p.system || '').includes('connectivity probe'));
  assert.ok(probe.length >= 2, '至少探测 m-b 与回头探 m-a');
});

// SMK-19：首条 3s 内出首个 chunk → 正常完成，不触发探测、无 fallbackUsed
test('SMK-19 healthy head: no probe, no fallbackUsed', async () => {
  const seen = [];
  const { handlers } = boot({
    llm: mockLlmProbe(seen, {}),
    timer: REAL_TIMER,
  });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm-a' }, { provider: 'p', model: 'm-b' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'm-a', '首条完成');
  assert.equal(out.fallbackUsed, undefined, '首条正常完成不置 fallbackUsed');
  const probe = seen.filter((p) => String(p.system || '').includes('connectivity probe'));
  assert.equal(probe.length, 0, '健康路径零探测');
  assert.equal(seen.length, 1, '仅一次生成调用');
});

// SMK-20（v3.3.3 新增）：生成级失败耗尽 → 整链重试一次 → 第二轮命中 m-b（链耗尽重试轮）
test('SMK-20 chain exhausted → one whole-chain retry reaches m-b (v3.3.3)', async () => {
  const seen = [];
  let bGenCount = 0;
  const okStream = streamOf([
    { type: 'text-delta', text: 'ENH' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const failStream = (model) => streamOf([{
    type: 'finish',
    reason: { kind: 'error', failure: { code: model === 'm-a' ? 'EMPTY' : 'QUOTA', message: 'gen failed' } },
  }]);
  const { handlers } = boot({
    llm: {
      stream(params) {
        seen.push(params);
        if (String(params.system || '').includes('connectivity probe')) return okStream;
        if (params.model === 'm-a') return failStream('m-a'); // 恒失败
        bGenCount += 1;                                        // m-b：第一轮失败、第二轮成功
        return bGenCount === 1 ? failStream('m-b') : okStream;
      },
    },
    timer: REAL_TIMER,
  });
  const out = await handlers.get('enhance')({
    sessionId: 's',
    seq: 1,
    text: '优化一下',
    config: {
      mode: 'base',
      fallback: [{ provider: 'p', model: 'm-a' }, { provider: 'p', model: 'm-b' }],
      params: { maxTokens: 2000, timeoutMs: 30000 },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.model, 'm-b', '重试轮第二模型完成');
  assert.equal(out.fallbackUsed, true, '非首个模型完成 → fallbackUsed');
  const gen = seen.filter((p) => !String(p.system || '').includes('connectivity probe'));
  assert.deepEqual(gen.map((p) => p.model), ['m-a', 'm-b', 'm-a', 'm-b'], '两轮 × 两模型（耗尽后整链重试一次）');
  const probe = seen.filter((p) => String(p.system || '').includes('connectivity probe'));
  assert.equal(probe.length, 0, '生成级失败不触发连通性探测');
});
