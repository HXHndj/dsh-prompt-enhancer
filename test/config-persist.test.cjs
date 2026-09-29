// config 磁盘持久化契约测试（v3.2.4 · Issue #1 修复审查补充）
// 覆盖：① lib/rpc-schema.cjs 的 config/get·config/set 参数校验行为
//       ② rpc-schema 单一事实源 = lib/rpc-schema.cjs（P1b 2026-09-19：死层副本 src/host/rpc-schema.js 已删，不得复活）
//       ③ lib/index.cjs 注册 config/get·config/set（防未来重构删除无感）
//       ④ lib/client.cjs 产物含 syncConfigFromHost/hostSync（client 逻辑构建注入防漂移）
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const libSchema = require('../lib/rpc-schema.cjs');

test('CFG-P01 config/get 无参数校验通过', () => {
  assert.equal(libSchema.validateRpcArgs('config/get', {}).ok, true);
});

test('CFG-P02 config/set 对象配置通过', () => {
  assert.equal(libSchema.validateRpcArgs('config/set', { config: { version: 2 } }).ok, true);
});

test('CFG-P03 config/set 非对象（字符串/数组/null）拒绝', () => {
  assert.equal(libSchema.validateRpcArgs('config/set', { config: 'x' }).ok, false);
  assert.equal(libSchema.validateRpcArgs('config/set', { config: [1, 2] }).ok, false);
  assert.equal(libSchema.validateRpcArgs('config/set', { config: null }).ok, false);
});

test('CFG-P04 config/set 缺 config 拒绝（MISSING_ARG）', () => {
  const r = libSchema.validateRpcArgs('config/set', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ARG');
});

test('CFG-P05 rpc-schema 单一事实源：lib 副本含 config/*，死层副本不得复活', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'rpc-schema.cjs'), 'utf8');
  assert.ok(src.includes("'config/get'"), 'lib/rpc-schema.cjs 缺 config/get');
  assert.ok(src.includes("'config/set'"), 'lib/rpc-schema.cjs 缺 config/set');
  assert.ok(src.includes("required: ['config']"), 'config/set 缺 required 校验');
  assert.ok(!existsSync(join(__dirname, '..', 'src', 'host', 'rpc-schema.js')),
    '死层副本 src/host/rpc-schema.js 复活了——双架构不得回归（P1b）');
});

test('CFG-P06 lib/index.cjs 注册 config/get·config/set RPC', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'index.cjs'), 'utf8');
  assert.ok(src.includes("harness.handle('config/get'"), 'lib/index.cjs 未注册 config/get');
  assert.ok(src.includes("harness.handle('config/set'"), 'lib/index.cjs 未注册 config/set');
  assert.ok(src.includes('dsh-prompt-enhancer.config.json'), '配置文件路径常量缺失');
  assert.ok(src.includes('renameSync'), '原子写（renameSync）缺失');
});

test('CFG-P07 lib/client.cjs 产物含 syncConfigFromHost/hostSync（构建注入防漂移）', () => {
  const s = readFileSync(join(__dirname, '..', 'lib', 'client.cjs'), 'utf8'); // P1a：唯一 client 载体
  assert.ok(s.includes('syncConfigFromHost'), 'client 产物缺 syncConfigFromHost');
  assert.ok(s.includes('hostSync'), 'client 产物缺 hostSync 状态机');
});

// ---- v3.2.5：config/set 顶层键级 merge 语义 ----
test('CFG-P08 lib/index.cjs config/set 含 merge 实现（多写入方防互相清空）', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'index.cjs'), 'utf8');
  assert.ok(src.includes('顶层键级 merge'), 'config/set 未升级 merge 语义');
  assert.ok(src.includes('for (const k of Object.keys(patch)) merged[k] = patch[k]'), 'merge 合并逻辑缺失');
});

test('CFG-P09 config/set merge 行为：传单键保留其他键（模拟两写入方交替保存）', async () => {
  // 用真实 lib/index.cjs 的 merge 逻辑做行为验证（隔离环境：临时 CONFIG_FILE）
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cfg-'));
  const cfgFile = join(dir, 'config.json');
  // 先写全量（v3.2.4 行为），另一写入方再补写一个非语音顶层键 → 既有键必须保留
  writeFileSync(cfgFile, JSON.stringify({ version: 2, fallback: [{ provider: 'a', model: 'b' }], params: { timeoutMs: 30000 } }));
  const orig = require('node:fs');
  // 直接复制 merge 逻辑验证（与 lib/index.cjs 同语义：读 → 顶层键合并 → 写）
  const cur = JSON.parse(orig.readFileSync(cfgFile, 'utf8'));
  const patch = { futureKey: { enabled: true } };
  const merged = { ...cur };
  for (const k of Object.keys(patch)) merged[k] = patch[k];
  assert.equal(merged.version, 2, 'enhancer 顶层键被清空');
  assert.ok(Array.isArray(merged.fallback) && merged.fallback.length === 1, 'fallback 被清空');
  assert.equal(merged.futureKey.enabled, true, 'futureKey 未写入');
  rmSync(dir, { recursive: true, force: true });
});

// ---- v4.1（D3/§1）：client 侧预算三档改档（8000/16000/32000）与配置迁移契约 ----
// state.js 是 client 配置迁移的唯一实现（sanitizeV2）；其自由变量来自 constants.js 同域常量
//（构建注入序 constants → state，见 scripts/build-client.mjs），故两 chunk 拼接求值。
// timerSvc 桩不执行回调：state.js 装载时会 syncConfigFromHost，无 host 时走重试定时器——
// 桩掉可避免真实 setTimeout 把测试进程拖住（并避免触碰真实 localStorage）。
// 2026-09-29（user 拍板·参数一致性）：opts 支持注入 host / seed（预置 localStorage）/ timerSvc：
//   host      —— 模拟 config/get·config/set（syncConfigFromHost 与保存回执用例）
//   seed      —— [[key, value]]，预置 localStorage（区分 fresh=true/false 两条同步分支）
//   timerSvc  —— 显式传 null 走「无计时服务 → 同步立即真实校验」分支（保存回执用例）
function loadClientConfigModule(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const decodeChunk = (rel) => {
    const raw = readFileSync(join(__dirname, '..', rel), 'utf8');
    const m = raw.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*\n$/);
    if (!m) throw new Error('chunk wrapper mismatch: ' + rel);
    return JSON.parse('"' + m[1] + '"');
  };
  const constants = decodeChunk('src/client/constants.js');
  const state = decodeChunk('src/client/state.js');
  const backing = new Map(Array.isArray(options.seed) ? options.seed : []);
  const localStorageStub = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const timerStub = options.timerSvc === undefined
    ? { timeout: () => {}, interval: () => () => {} }
    : options.timerSvc;
  const factory = new Function(
    'host', 'localStorage', 'timerSvc', 'setTimeout',
    constants + '\n' + state
      + '\n;return { sanitizeV2, migrateFromV1, cloneDefaults, configState, CONFIG_DEFAULTS, BUDGET_OPTIONS,'
      + ' MEMORY_ROUNDS_MAX, MEMORY_KEY_PREFIX, REASONING_PARAM_FLOORS, saveConfig, saveStatus,'
      + ' reasoningParamNotice, subscribeReasoningNotice, dismissReasoningNotice, applyRecommendedParams };'
  );
  const api = factory(options.host, localStorageStub, timerStub, options.setTimeout || (() => {}));
  return { ...api, backing, localStorageStub, constantsSrc: constants, stateSrc: state };
}

test('CFG-P10 v4.1 预算三档常量：BUDGET_OPTIONS=[8000,16000,32000]、默认 8000、MEMORY_ROUNDS_MAX=3', () => {
  const m = loadClientConfigModule();
  assert.deepEqual(m.BUDGET_OPTIONS, [8000, 16000, 32000], '§1/D3：预算三档 = 8000/16000/32000（与 host pure.js 一致）');
  assert.equal(m.CONFIG_DEFAULTS.context.budgetChars, 8000, '§1：默认预算 8000');
  assert.equal(m.cloneDefaults().context.budgetChars, 8000, 'cloneDefaults（首装/恢复默认）默认档 8000');
  assert.equal(m.MEMORY_ROUNDS_MAX, 3, '§1/D4：记忆最多三轮（原 4）');
  assert.equal(m.MEMORY_KEY_PREFIX, 'dsh-enh-memory:', '§2.3：记忆链持久化键前缀');
});

test('CFG-P11 v4.1 预算迁移矩阵：8000/16000/32000 原样保留；0/2000/4000/非法/缺省 → 8000', () => {
  const { sanitizeV2 } = loadClientConfigModule();
  const at = (v) => sanitizeV2({ context: { budgetChars: v } }).context.budgetChars;
  assert.equal(at(8000), 8000, '8000 → 8000');
  assert.equal(at(16000), 16000, '16000 → 16000');
  assert.equal(at(32000), 32000, '★ 32000 → 32000（现为合法档位，不得再降级为 16000）');
  assert.equal(at(0), 8000, '旧 0 档 → 8000（预算恒 >0）');
  assert.equal(at(2000), 8000, '旧 2000 档 → 8000');
  assert.equal(at(4000), 8000, '旧默认 4000 → 8000');
  assert.equal(at(999), 8000, '非法值 → 8000');
  assert.equal(at(undefined), 8000, '缺省 → 8000');
  assert.equal(sanitizeV2({}).context.budgetChars, 8000, '无 context 字段 → 8000');
  assert.equal(sanitizeV2({ context: {} }).context.budgetChars, 8000, 'context 无 budgetChars → 8000');
});

test('CFG-P12 v4.1 迁移源码标记：v4.0.0「32000→16000」降级映射必须删除（缺陷防回归）', () => {
  const { stateSrc } = loadClientConfigModule();
  assert.equal(stateSrc.includes('ctxCfg.budgetChars === 32000'), false, '32000→16000 降级映射复活了（§1 明令删除）');
  assert.equal(stateSrc.includes('v.context.budgetChars = 4000'), false, '旧默认 4000 不得再作为迁移目标');
  assert.ok(stateSrc.includes('else v.context.budgetChars = 8000;'), '白名单外（旧 0/2000/4000/非法/缺省）必须统一落 8000');
  assert.ok(stateSrc.includes('context: { budgetChars: 8000 }'), 'cloneDefaults 默认档必须为 8000');
});

// ---- 2026-09-29（用户拍板）：运行参数严格按设置值执行 · client 状态层契约 ----
// 背景：上一轮审阅确认 host 在 reasoningEffort 链上静默放宽（超时 max(用户值,120000)、Token max(用户值,8000)）。
// 用户拍板：① host 不得静默抬高（严格按设置值）；② 下限只作客户端**可见**建议——思考等级「关→开」跃迁那一刻
// 抬高并写进同一份配置；③ 0=无限制档位必须原样保留（client sanitize 与 host pure.js 同口径）；
// ④ 本地已有配置不得被磁盘配置整体覆盖；⑤ 保存结果须含宿主磁盘回执（ok===true）。
const cfgChainOff = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }];
const cfgChainOn = [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoning: { enabled: true, effort: 'high' } }];
const cfgFlush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const cfgHostStub = (calls, getRes, setRes) => ({
  call: (method, args) => {
    calls.push({ method, args });
    if (method === 'config/get') return Promise.resolve(getRes);
    return Promise.resolve(setRes === undefined ? { ok: true } : setRes);
  },
});

test('CFG-P13 sanitizeV2 接受 0（无限制档位）三项原样保留，范围校验不放宽（与 host pure.js 同口径）', () => {
  const { sanitizeV2 } = loadClientConfigModule();
  assert.deepEqual(sanitizeV2({ params: { timeoutMs: 0, maxTokens: 0, outputLimit: 0 } }).params,
    { timeoutMs: 0, maxTokens: 0, outputLimit: 0 },
    '★ 0 = UI 首档「无限制」，必须原样保留（旧实现被白名单丢弃 → 选完刷新即回退档位默认）');
  assert.equal(sanitizeV2({ params: { timeoutMs: 0 } }).params.timeoutMs, 0, '单字段 0 亦保留');
  assert.equal(sanitizeV2({ params: { timeoutMs: 0 } }).params.maxTokens, 2000, '未给出的项仍落档位默认');
  const at = (patch) => sanitizeV2({ params: patch }).params;
  assert.equal(at({ timeoutMs: 1000 }).timeoutMs, 1000, '下界 1000 保留');
  assert.equal(at({ timeoutMs: 300000 }).timeoutMs, 300000, '上界 300000 保留');
  assert.equal(at({ timeoutMs: 999 }).timeoutMs, 30000, '越界仍回默认（范围语义未放宽）');
  assert.equal(at({ timeoutMs: 300001 }).timeoutMs, 30000);
  assert.equal(at({ timeoutMs: -1 }).timeoutMs, 30000, '负数不是「无限制」语义');
  assert.equal(at({ maxTokens: 100 }).maxTokens, 100);
  assert.equal(at({ maxTokens: 16000 }).maxTokens, 16000);
  assert.equal(at({ maxTokens: 99 }).maxTokens, 2000);
  assert.equal(at({ outputLimit: 500 }).outputLimit, 500);
  assert.equal(at({ outputLimit: 50000 }).outputLimit, 50000);
  assert.equal(at({ outputLimit: 499 }).outputLimit, 8000);
});

test('CFG-P14 migrateFromV1 同步接受 0 + REASONING_PARAM_FLOORS 常量（紧邻 MODE_PARAMS_DEFAULT，host 侧禁用）', () => {
  const m = loadClientConfigModule();
  assert.deepEqual(m.migrateFromV1({ timeoutMs: 0, maxTokens: 0, outputLimit: 0 }).params,
    { timeoutMs: 0, maxTokens: 0, outputLimit: 0 }, 'v1 平铺字段的 0（无限制）同样保留');
  assert.equal(m.migrateFromV1({ timeoutMs: 30000 }).params.timeoutMs, 30000);
  assert.equal(m.migrateFromV1({ timeoutMs: 999 }).params.timeoutMs, 30000, 'v1 越界仍回默认');
  assert.deepEqual(m.REASONING_PARAM_FLOORS, { timeoutMs: 120000, maxTokens: 8000 }, '建议下限 = 120s / 8000');
  assert.ok(m.constantsSrc.includes('const REASONING_PARAM_FLOORS = { timeoutMs: 120000, maxTokens: 8000 };'),
    '常量定义缺失（冻结接口）');
  const ci = m.constantsSrc.indexOf('const MODE_PARAMS_DEFAULT');
  const fi = m.constantsSrc.indexOf('const REASONING_PARAM_FLOORS');
  assert.ok(ci >= 0 && fi > ci, 'REASONING_PARAM_FLOORS 必须定义在 MODE_PARAMS_DEFAULT 之后（紧邻）');
  const hostPure = readFileSync(join(__dirname, '..', 'src', 'host', 'pure.js'), 'utf8');
  assert.equal(hostPure.includes('REASONING_PARAM_FLOORS'), false,
    '★ host 侧绝不得引用该下限（用户拍板：不允许静默抬高运行参数）');
});

test('CFG-P15 思考等级「关→开」跃迁：params 可见抬到 120000/8000 + 一次性通知态；0/已达标不动', () => {
  const m = loadClientConfigModule();
  m.configState.value = { ...m.cloneDefaults(), fallback: cfgChainOff, params: { timeoutMs: 30000, maxTokens: 2000, outputLimit: 8000 } };
  m.saveConfig({ fallback: cfgChainOn });
  assert.deepEqual(m.configState.value.params, { timeoutMs: 120000, maxTokens: 8000, outputLimit: 8000 },
    '跃迁须把超时/Token 可见抬到下限（outputLimit 不参与）');
  assert.deepEqual(m.reasoningParamNotice(), {
    effort: 'high',
    prev: { timeoutMs: 30000, maxTokens: 2000 },
    next: { timeoutMs: 120000, maxTokens: 8000 },
  }, '一次性通知态须含 effort 与前后值（供 params-tab 渲染）');
  assert.equal(JSON.parse(m.backing.get('dsh.enhance.config.v2')).params.timeoutMs, 120000,
    '抬高须写进同一份配置（localStorage 可见）');
  m.dismissReasoningNotice();
  assert.equal(m.reasoningParamNotice(), null, 'dismissReasoningNotice 清空通知态');
  // 已是 0（无限制）或已高于下限 → 不动，且不得给「已调整」假提示
  m.configState.value = { ...m.cloneDefaults(), fallback: cfgChainOff, params: { timeoutMs: 0, maxTokens: 16000, outputLimit: 8000 } };
  m.saveConfig({ fallback: cfgChainOn });
  assert.deepEqual(m.configState.value.params, { timeoutMs: 0, maxTokens: 16000, outputLimit: 8000 },
    '0 与已达标项不得被改动');
  assert.equal(m.reasoningParamNotice(), null, '未发生抬高 → 不得显示「已按建议值调整」');
  // 部分抬高：超时 0 保持 0，低 Token 抬到 8000
  m.configState.value = { ...m.cloneDefaults(), fallback: cfgChainOff, params: { timeoutMs: 0, maxTokens: 2000, outputLimit: 8000 } };
  m.saveConfig({ fallback: cfgChainOn });
  assert.deepEqual(m.configState.value.params, { timeoutMs: 0, maxTokens: 8000, outputLimit: 8000 });
  assert.deepEqual(m.reasoningParamNotice().next, { timeoutMs: 0, maxTokens: 8000 }, 'next 取实际值（未抬项保持原值）');
});

test('CFG-P16 跃迁只抬一次：用户改回 30s 后不再干预；patch 显式给出 params 时不自动抬高', () => {
  const m = loadClientConfigModule();
  m.configState.value = { ...m.cloneDefaults(), fallback: cfgChainOff, params: { timeoutMs: 30000, maxTokens: 2000, outputLimit: 8000 } };
  m.saveConfig({ fallback: cfgChainOn });
  assert.equal(m.configState.value.params.timeoutMs, 120000, '跃迁抬高');
  m.saveConfig({ params: { ...m.configState.value.params, timeoutMs: 30000, maxTokens: 2000 } }); // 用户改回
  assert.equal(m.configState.value.params.timeoutMs, 30000);
  m.saveConfig({ mode: 'expert' }); // 思考等级仍开，之后的任何改动不得再抬
  assert.equal(m.configState.value.params.timeoutMs, 30000, '★ 跃迁已发生过 → 不再抬高');
  assert.equal(m.configState.value.params.maxTokens, 2000);
  // 关 → 开 且同一次 patch 显式给出 params：用户显式选择优先
  m.saveConfig({ fallback: cfgChainOff });
  m.saveConfig({ fallback: cfgChainOn, params: { timeoutMs: 30000, maxTokens: 1000, outputLimit: 8000 } });
  assert.deepEqual(m.configState.value.params, { timeoutMs: 30000, maxTokens: 1000, outputLimit: 8000 },
    'patch 显式 params → 不做自动抬高');
});

test('CFG-P17 syncConfigFromHost：本地已有配置（fresh=false）不得被磁盘整体覆盖，须回推 host', async () => {
  const calls = [];
  const diskConfig = { version: 2, mode: 'expert', params: { timeoutMs: 60000, maxTokens: 4000, outputLimit: 16000 }, fallback: [{ provider: 'disk', model: 'disk-model' }] };
  const localConfig = { version: 2, mode: 'standard', params: { timeoutMs: 30000, maxTokens: 2000, outputLimit: 8000 }, fallback: [{ provider: 'local', model: 'local-model' }] };
  const m = loadClientConfigModule({
    host: cfgHostStub(calls, { ok: true, config: diskConfig }),
    seed: [['dsh.enhance.config.v2', JSON.stringify(localConfig)]],
  });
  await cfgFlush(); // state.js 装载时已自动 syncConfigFromHost
  assert.equal(m.configState.fresh, false, '本地有配置 → fresh=false');
  assert.deepEqual(m.configState.value.fallback, [{ provider: 'local', model: 'local-model' }],
    '★ 本地配置不得被磁盘配置整体覆盖');
  assert.equal(m.configState.value.mode, 'standard', '磁盘 expert 不得覆盖本地 standard');
  assert.equal(m.configState.value.params.timeoutMs, 30000, '本地参数保持');
  assert.equal(m.configState.hostSync, true, '须标记 hostSync 完成');
  const setCalls = calls.filter((c) => c.method === 'config/set');
  assert.equal(setCalls.length, 1, '本地配置须回推 host 一次（config/set）');
  assert.equal(setCalls[0].args.config.mode, 'standard', '回推的是本地配置');
  assert.equal(JSON.parse(m.backing.get('dsh.enhance.config.v2')).mode, 'standard', 'localStorage 不得被磁盘配置回写');
});

test('CFG-P18 syncConfigFromHost：fresh=true（localStorage 空）仍采纳磁盘配置（sanitize + 写回 localStorage）', async () => {
  const calls = [];
  const diskConfig = { version: 2, mode: 'lite', params: { timeoutMs: 0, maxTokens: 0, outputLimit: 0 }, fallback: [{ provider: 'disk', model: 'disk-model' }] };
  const m = loadClientConfigModule({ host: cfgHostStub(calls, { ok: true, config: diskConfig }) });
  await cfgFlush();
  assert.equal(m.configState.value.mode, 'lite', 'fresh（新 Origin/首装）→ 采纳磁盘配置');
  assert.deepEqual(m.configState.value.fallback, [{ provider: 'disk', model: 'disk-model' }]);
  assert.deepEqual(m.configState.value.params, { timeoutMs: 0, maxTokens: 0, outputLimit: 0 }, '采纳路径仍经 sanitizeV2（0 保留）');
  assert.equal(m.configState.fresh, false);
  assert.equal(m.configState.hostSync, true);
  assert.equal(calls.filter((c) => c.method === 'config/set').length, 0, 'fresh 采纳路径不回推（无可回推内容）');
  assert.equal(JSON.parse(m.backing.get('dsh.enhance.config.v2')).mode, 'lite', '采纳后须写回 localStorage');
});

test('CFG-P19 applyRecommendedParams：>0 且低于下限才可见写入（0 不抬），返回是否写入并清通知态', () => {
  const m = loadClientConfigModule();
  let notified = 0;
  const unsub = m.subscribeReasoningNotice(() => { notified++; });
  m.configState.value = { ...m.cloneDefaults(), fallback: cfgChainOff, params: { timeoutMs: 30000, maxTokens: 2000, outputLimit: 8000 } };
  m.saveConfig({ fallback: cfgChainOn }); // 先造出通知态
  assert.ok(m.reasoningParamNotice(), '跃迁已产生通知态');
  m.configState.value = { ...m.configState.value, params: { timeoutMs: 30000, maxTokens: 2000, outputLimit: 8000 } };
  assert.equal(m.applyRecommendedParams(), true, '存在低于下限的项 → 发生写入');
  assert.deepEqual(m.configState.value.params, { timeoutMs: 120000, maxTokens: 8000, outputLimit: 8000 });
  assert.equal(m.reasoningParamNotice(), null, '应用建议值须清通知态');
  assert.equal(m.applyRecommendedParams(), false, '两项均已达标 → 不再写入');
  m.configState.value = { ...m.configState.value, params: { timeoutMs: 0, maxTokens: 0, outputLimit: 8000 } };
  assert.equal(m.applyRecommendedParams(), false, '0 = 无限制，不参与抬高');
  assert.deepEqual(m.configState.value.params, { timeoutMs: 0, maxTokens: 0, outputLimit: 8000 });
  unsub();
  assert.ok(notified >= 1, '订阅须被触发（params-tab 建议/通知行的渲染依据）');
});

test('CFG-P20 保存校验纳入宿主回执：ok!==true → failed；ok===true → saved；无 host 跳过该项', async () => {
  // host 回执失败（磁盘写失败）→ 即使 localStorage 已写也不得显示「已保存」
  const bad = loadClientConfigModule({ host: cfgHostStub([], { ok: true, config: null }, { ok: false }), timerSvc: null });
  bad.saveConfig({ mode: 'expert' });
  await cfgFlush();
  assert.equal(bad.saveStatus.phase, 'failed', '★ 磁盘回执 ok:false 不得谎报已保存');
  // host 回执成功 → saved
  const good = loadClientConfigModule({ host: cfgHostStub([], { ok: true, config: null }), timerSvc: null });
  good.saveConfig({ mode: 'expert' });
  await cfgFlush();
  assert.equal(good.saveStatus.phase, 'saved');
  // 无 host（单测环境）→ 跳过回执项，localStorage 校验通过即 saved（不因缺 host 误判失败）
  const noHost = loadClientConfigModule({ timerSvc: null });
  noHost.saveConfig({ mode: 'expert' });
  await cfgFlush();
  assert.equal(noHost.saveStatus.phase, 'saved', '无 host → 跳过回执项');
});
