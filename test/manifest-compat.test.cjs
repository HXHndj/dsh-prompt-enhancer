'use strict';
// v4.2.5（DSH 0.2.0-rc.1 门禁适配）manifest 契约测试。
//
// 背景（事故驱动；完整取证见 docs/migration-dsh-0.2.0-rc1-report.md）：
//   DSH 0.2.0-rc.1 的 profile 启动门禁**只读** package.json 的 peerDependencies，把**每一条**
//   `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围与「运行时版本」比对：
//       semver.satisfies(runtimeVersion, range, { includePrerelease: true })
//   任一条不满足 ⇒ 整个插件被拒（host 半部与 client 半部都不加载，插件列表显示「异常」）。
//   v4.2.4 声明的 `^0.1.0-rc.6` 在 0.x 上等价 `>=0.1.0-rc.6 <0.2.0` ⇒ 宿主升到 0.2.0-rc.1
//   当天即被判不兼容（实测日志：`profile startup denies it`）。
//
// 本测试把三条教训钉成契约（纯字符串/结构断言，**零依赖**——不引 semver，CI 无需装包即可跑）：
//   MCOMPAT-01  dsh 系 peer 不得用 `^` / `~`（0.x 上会隐式排除下一个 minor —— 正是本次根因）
//   MCOMPAT-02  dsh 系 peer 必须显式双侧窗口（`>=` + `<`）或 workspace: 形式 —— 窗口可读、可审
//   MCOMPAT-03  0.2 线已淘汰包名不得再出现（peer 与 dsh.client.inject 双向）
//   MCOMPAT-04  dsh.client.inject 形制 + 「slots 服务提供者」在位
//   MCOMPAT-05  engines.dsh（声明时）与 peer 窗口同源（同一下限）
//   MCOMPAT-06  版本号单一事实源：package.json ↔ package-lock.json（根 + packages[""]）
//
// 注意：这些是**本仓库的策略**，不是 DSH 的要求（DSH 只需 range 满足运行时版本，甚至允许整块不声明）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

// 门禁的名字筛选口径（逐字对齐 0.2.0-rc.1 的 evaluatePluginCompatibility）
const isDshPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
// 0.2 线已淘汰：npm 最后发布 0.1.1-rc.2，0.2.0-rc.1 的客户端启动图与 asar 内均无此包
const RETIRED = [
  '@deepseek-ai/dsh-client-runtime',
];
// 0.2.0-rc.1 起 `ctx.slots` 服务的提供者（0.1.x 由 dsh-client-runtime 提供）
const SLOTS_PROVIDER = '@deepseek-ai/dsh-client-ui-renderer';
const WORKSPACE_FORMS = ['workspace:^', 'workspace:~', 'workspace:*'];

const dshPeers = Object.entries(pkg.peerDependencies || {}).filter(([name]) => isDshPeer(name));

test('MCOMPAT-01 dsh 系 peer 不得使用 ^ / ~ 范围（0.x 上会隐式排除下一个 minor）', () => {
  assert.ok(dshPeers.length > 0, '至少应声明一条 dsh 系 peer（本仓库策略：保留可审窗口）');
  for (const [name, range] of dshPeers) {
    assert.ok(
      !/^[\^~]/.test(range.trim()),
      `${name} 使用了 "${range}"：^ / ~ 在 0.x 上会锁死 minor（^0.1.0 => >=0.1.0 <0.2.0），`
      + '宿主升 minor 即被判不兼容（v4.2.4 事故根因）。请改用双侧窗口，如 ">=0.1.5-rc.1 <0.3.0"。',
    );
  }
});

test('MCOMPAT-02 dsh 系 peer 必须是双侧窗口（>= 与 <）或 workspace: 形式', () => {
  for (const [name, range] of dshPeers) {
    const r = range.trim();
    if (WORKSPACE_FORMS.includes(r)) continue; // DSH 官方等价形式：指向当前运行时版本
    assert.match(r, />=/, `${name} 的 "${r}" 缺下限（>=）`);
    assert.match(r, /</, `${name} 的 "${r}" 缺上限（<）——上限是「宿主升到 0.3 时被明确拒绝而非静默加载」的唯一保障`);
  }
});

test('MCOMPAT-03 已淘汰包名不得出现在 peerDependencies / dsh.client.inject', () => {
  const inject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject) || [];
  for (const dead of RETIRED) {
    assert.ok(!Object.hasOwn(pkg.peerDependencies || {}, dead), `peerDependencies 仍声明了已淘汰的 ${dead}`);
    assert.ok(!inject.includes(dead), `dsh.client.inject 仍引用已淘汰的 ${dead}（0.2 启动图中不存在该行，写它只会误导）`);
  }
});

test('MCOMPAT-04 dsh.client.inject 形制 + slots 提供者（renderer）在位', () => {
  const client = pkg.dsh && pkg.dsh.client;
  assert.ok(client && typeof client === 'object', 'package.json 缺 dsh.client 段');
  assert.equal(client.platform, 'web', 'dsh.client.platform 必须为 web（0.2.0-rc.1 的 web 消费端只接受 web）');
  const inject = client.inject;
  assert.ok(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject 必须是非空数组');
  for (const id of inject) {
    assert.equal(typeof id, 'string', 'dsh.client.inject 条目必须是字符串包名');
    assert.ok(id.startsWith('@deepseek-ai/'), `dsh.client.inject 条目 "${id}" 不是 @deepseek-ai/ 包名`);
  }
  assert.ok(inject.includes(SLOTS_PROVIDER), `dsh.client.inject 缺 slots 服务提供者 ${SLOTS_PROVIDER}`);
  assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'), 'dsh.client.inject 缺 i18n 取词源 @deepseek-ai/dsh-client-locale');
});

test('MCOMPAT-05 engines.dsh（声明时）与 peer 窗口同源', () => {
  const enginesDsh = pkg.engines && pkg.engines.dsh;
  if (enginesDsh === undefined) return; // 可选字段（DSH 明示不强制）
  assert.match(enginesDsh, />=/, 'engines.dsh 缺下限');
  assert.match(enginesDsh, /</, 'engines.dsh 缺上限');
  const floor = (range) => range.trim().split(/\s+/).find((t) => t.startsWith('>='));
  for (const [name, range] of dshPeers) {
    if (WORKSPACE_FORMS.includes(range.trim())) continue;
    assert.equal(floor(enginesDsh), floor(range), `engines.dsh(${enginesDsh}) 与 ${name}(${range}) 的下限不一致——两处声明必须同源`);
  }
});

test('MCOMPAT-06 版本号与 peer 声明的单一事实源：package.json ↔ package-lock.json', () => {
  assert.equal(lock.version, pkg.version, `package-lock.json 根 version ${lock.version} ≠ package.json ${pkg.version}`);
  const lockRoot = lock.packages && lock.packages[''];
  assert.ok(lockRoot, 'package-lock.json 缺 packages[""] 根条目');
  assert.equal(lockRoot.version, pkg.version, `lock packages[""].version ${lockRoot.version} ≠ package.json ${pkg.version}`);
  assert.deepEqual(
    lockRoot.peerDependencies || {},
    pkg.peerDependencies || {},
    'lock 根 peerDependencies 与 package.json 不一致（改声明后必须重解析 lock）',
  );
});
