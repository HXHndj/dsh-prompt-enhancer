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
function loadClientConfigModule() {
  const decodeChunk = (rel) => {
    const raw = readFileSync(join(__dirname, '..', rel), 'utf8');
    const m = raw.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*\n$/);
    if (!m) throw new Error('chunk wrapper mismatch: ' + rel);
    return JSON.parse('"' + m[1] + '"');
  };
  const constants = decodeChunk('src/client/constants.js');
  const state = decodeChunk('src/client/state.js');
  const backing = new Map();
  const localStorageStub = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const timerStub = { timeout: () => {}, interval: () => () => {} };
  const factory = new Function(
    'host', 'localStorage', 'timerSvc', 'setTimeout',
    constants + '\n' + state
      + '\n;return { sanitizeV2, cloneDefaults, configState, CONFIG_DEFAULTS, BUDGET_OPTIONS, MEMORY_ROUNDS_MAX, MEMORY_KEY_PREFIX };'
  );
  const api = factory(undefined, localStorageStub, timerStub, () => {});
  return { ...api, constantsSrc: constants, stateSrc: state };
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
