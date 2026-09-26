'use strict';
// client-model-config —— v3.6 单选模型配置的接线契约与行为抽检（2026-09-26 方案驱动）
// 手法：解码 src/client 字符串模块（module.exports="..." 单物理行，内层换行为字面 \r\n 转义）后
// 做源码标记断言（防「注释有、代码无」半成品）与 testFailKey/i18n 行为级抽检。
// 封尾双形态：多数 chunk 以 `";` + 物理换行结尾，model-main-section.js 以 `"` 结束（无分号无换行）——
// 旧正则 /";?\s*\n$/ 对后者 match=no（会误抛 chunk wrapper mismatch），故此处用双形态正则。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 双形态封尾正则：兼容 `";\r\n` / `";\n` / `";`（无尾换行）/ `"`（无分号无尾换行）四种封尾
const decodeChunk = (rel) => {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = raw.match(/module\.exports\s*=\s*"([\s\S]*)";?\s*$/);
  if (!m) throw new Error('chunk wrapper mismatch: ' + rel);
  return JSON.parse('"' + m[1] + '"');
};

test('CFG-UI wiring: model-main-section 已改单选（fallback[0] 受控 + legacy 提示 + 收敛写回）', () => {
  const src = decodeChunk('src/client/components/model-main-section.js');
  // 单选三收敛点：updateEntry → [entry]、✕清除 → []、恢复默认 → [官方默认第一项]
  assert.ok(src.includes('fallback[0]'), '受控值必须是 fallback[0]（非本地 state）');
  assert.ok(src.includes('saveFallback(['), '收敛写回必须以单条数组形式 saveFallback([...]');
  assert.ok(src.includes('cfgLegacyMulti'), '缺旧版多模型队列收敛提示');
  assert.ok(src.includes('secSingleModel'), '缺「当前模型」摘要键');
  assert.ok(src.includes("role: 'note'"), 'legacy 提示需可访问性 role=note');
  assert.ok(src.includes("saveFallback([])"), '✕ 清除必须写空数组');
  // v3.6.1（评审修复）：清除后的空态不得是「选模型死路」——必须以空 entry 渲染可写回卡片（重选入口）
  assert.ok(src.includes('EMPTY_ENTRY'), '空态必须以空 entry 渲染卡片（清除后仍有重选入口）');
  assert.ok((src.match(/secFallbackEmpty/g) || []).length >= 2, '空态提示须同时存在于区块摘要与卡片上方');
  assert.ok(src.includes('{ ...DEFAULT_MODEL_CHAIN[0] }'), '恢复默认只写官方默认第一项');
  assert.ok(src.includes('testFailKey'), '失败分类必须经 testFailKey 映射');
  assert.ok(src.includes("code: 'NETWORK'"), 'client RPC 层失败必须归 NETWORK（cfgTestFailNetwork 唯一可达路径）');
  // 多模型队列残留面必须清空
  for (const gone of ['addModel', 'onMove', 'cfgAddFallback', 'cfgChainHasInvalid', 'cfgRemoveInvalid', 'secFallbackCount', 'cfgMeasureLiveFail', 'rowUp', 'rowDown']) {
    assert.equal(src.includes(gone), false, '单选组件不得残留多模型队列标识: ' + gone);
  }
});

test('CFG-UI wiring: fallback-row 卡片化（注入 marker / resolve 纠偏 autoFix 门控保留）', () => {
  const src = decodeChunk('src/client/components/fallback-row.js');
  // 最高风险锚点：字符串尾注入 marker 丢失 → buildCandidates 整体消失且 --check 查不出
  assert.ok(src.includes('// @dsh-client-model-helpers-inject'), '字符串尾 model-helpers 注入 marker 丢失（build-client do-while 依赖）');
  assert.ok(src.includes("'models/resolve'"), '保留 models/resolve 能力表拉取');
  assert.ok(src.includes('autoFix'), 'resolve 纠偏必须经 autoFix 门控（legacy 态不写回）');
  assert.ok(src.includes('noCache'), '保留已启用思考条目的 noCache 取新鲜能力表');
  assert.ok(src.includes('dsh-plg-modelcard'), '卡片容器类在位');
  assert.ok(src.includes('dsh-plg-card-head'), 'head 行类在位');
  assert.ok(src.includes('disabled: !entry.provider && !entry.model'), '空卡片 ✕ 必须禁用（无可清除项；真条目不受影响）');
  for (const gone of ['onMove', 'rowUp', 'rowDown', 'props.index', 'props.count', 'dsh-plg-num']) {
    assert.equal(src.includes(gone), false, '卡片组件不得残留队列行标识: ' + gone);
  }
});

test('CFG-UI wiring: model-config-tab 首装继承只写单条（三路径全落地防回归）', () => {
  const src = decodeChunk('src/client/components/model-config-tab.js');
  assert.ok(src.includes('writeSingle'), '三条写回路径必须收敛到 writeSingle');
  assert.ok(src.includes('DEFAULT_MODEL_CHAIN[0]'), '无选中/RPC 拒绝必须回退官方默认第一项');
  assert.ok(src.includes('.catch(() => { writeSingle('), 'RPC 拒绝不得保留空 catch（否则 fresh 安装永远空链）');
  assert.ok(src.includes('fallback: [entry]'), '继承写入必须是长度 1 数组');
  assert.equal(src.includes('fill('), false, '补足整链逻辑（fill）必须删除——首装只写 1 条');
});

test('CFG-UI behavior: testFailKey 按 code 分类（STREAM_THROW 不映射 → Generic）', () => {
  const src = decodeChunk('src/client/helpers.js');
  const testFailKey = new Function(src + '\n;return testFailKey;')();
  assert.equal(testFailKey('TIMEOUT'), 'cfgTestFailTimeout');
  assert.equal(testFailKey('QUOTA'), 'cfgTestFailQuota');
  assert.equal(testFailKey('UNKNOWN_MODEL'), 'cfgTestFailUnknownModel');
  assert.equal(testFailKey('INVALID_CREDENTIAL'), 'cfgTestFailCredential');
  assert.equal(testFailKey('NO_LLM'), 'cfgTestFailNoAdapter');
  assert.equal(testFailKey('NO_ADAPTER'), 'cfgTestFailNoAdapter');
  assert.equal(testFailKey('EMPTY_RESPONSE'), 'cfgTestFailEmptyResponse');
  assert.equal(testFailKey('ABORTED'), 'cfgTestFailAborted');
  assert.equal(testFailKey('NETWORK'), 'cfgTestFailNetwork');
  assert.equal(testFailKey('WEIRD_PRIVATE_CODE'), 'cfgTestFailGeneric');
  assert.equal(testFailKey(undefined), 'cfgTestFailGeneric');
  // STREAM_THROW 只产自增强生成路径（host enhance-handlers.js），models/test 永不返回——不设映射项
  assert.equal(testFailKey('STREAM_THROW'), 'cfgTestFailGeneric', 'STREAM_THROW 必须落 Generic 兜底（证明映射项已删）');
});

test('CFG-UI i18n: 单选键集抽检（16 新增在位、7 退役两表均无；全量键集由 S-7 把关）', () => {
  const src = decodeChunk('src/client/i18n.js');
  const { ZH, EN } = new Function(src + '\n;return { ZH, EN };')();
  const added = [
    'secSingleModel', 'cfgLegacyMulti', 'cfgModelLabel', 'cfgProviderLabel', 'cfgModelNameLabel',
    'cfgReasoningLabel', 'cfgEffortLabel', 'cfgTestFailNetwork', 'cfgTestFailTimeout',
    'cfgTestFailUnknownModel', 'cfgTestFailCredential', 'cfgTestFailQuota', 'cfgTestFailNoAdapter',
    'cfgTestFailEmptyResponse', 'cfgTestFailAborted', 'cfgTestFailGeneric',
  ];
  const retired = ['rowUp', 'rowDown', 'secFallbackCount', 'cfgAddFallback', 'cfgChainHasInvalid', 'cfgRemoveInvalid', 'cfgMeasureLiveFail'];
  for (const k of added) {
    assert.ok(ZH[k] !== undefined, 'ZH 缺新增键: ' + k);
    assert.ok(EN[k] !== undefined, 'EN 缺新增键: ' + k);
  }
  for (const k of retired) {
    assert.equal(ZH[k], undefined, 'ZH 退役键未删: ' + k);
    assert.equal(EN[k], undefined, 'EN 退役键未删: ' + k);
  }
  // 值修订抽检（单选语义配套）
  assert.equal(ZH.rowRemove, '清除该模型');
  assert.equal(EN.rowRemove, 'Clear this model');
  assert.equal(ZH.errNO_MODEL, '未选择模型，请先在设置中选择模型');
  assert.equal(ZH.secFallbackEmpty, '未选择模型——增强前需先选择模型');
});
