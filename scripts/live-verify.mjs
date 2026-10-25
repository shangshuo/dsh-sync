/**
 * T4 真机验证脚本（只读真机数据，写入全部落在临时目录）：
 *  1. push：从真实 ~/.dsh 采集（白名单 + 默认模块），加密上传到临时本地目标
 *  2. pull(dryRun)：比对本机与快照
 *  3. pull(confirm)：恢复到真实 profile 的临时副本，逐文件核对
 *  4. 旧格式兼容：手工构造 0.3.x 结构的快照（含噪声条目），新引擎恢复时
 *     跳过噪声并按模块名告警
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultProfile, saveDocument } from '../lib/config.js';
import { openArchive, packContainer, sealArchive, unpackContainer } from '../lib/container.js';
import { SyncEngine } from '../lib/engine.js';
import { SecretStore } from '../lib/secrets.js';

const PASSPHRASE = 'LiveVerify@2026';
const realDshHome = path.join(os.homedir(), '.dsh');
const realProfileDir = path.join(realDshHome, 'profiles', 'desktop');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dshsync-live-'));
const remote = path.join(root, 'remote');

// ---------- 1. push（真实数据，状态文件写入临时 dshHome） ----------
const profile = defaultProfile('真机验证');
profile.target = { ...profile.target, kind: 'local', prefix: 'live', local: { path: remote } };
profile.passphrase = PASSPHRASE;
const store = new SecretStore({ dir: root });
await saveDocument(path.join(root, 'config.json'), store, { version: 2, active: '真机验证', profiles: [profile] });

const pushEngine = new SyncEngine({ dshHome: root, profileDir: realProfileDir, profileName: 'desktop' });
// 引擎的 config 路径指向真实 ~/.dsh/dsh-sync/config.json——不能动真机配置。
// 直接覆盖实例的路径到临时目录。
pushEngine.paths = { ...pushEngine.paths, config: path.join(root, 'config.json'), state: path.join(root, 'state.json'), log: path.join(root, 'sync.log'), backups: path.join(root, 'backups') };
pushEngine.store = store;

const pushed = await pushEngine.push({ reason: 'live-verify' });
assert.equal(pushed.skipped, false);
console.log(`✓ push：${pushed.stats.files} 个文件，${Math.round(pushed.bytes / 1024)} KB 密文`);
for (const r of pushed.stats.roots) console.log(`   ${r.present ? '✓' : '✗'} ${r.id}: ${r.files} 文件${r.sensitive ? ' [隐私]' : ''}`);
assert.ok(pushed.stats.roots.find((r) => r.id === 'profile').files <= 6, 'profile 白名单生效');
assert.ok(!pushed.key.includes('.plugin-manager'), '无日志噪声');

// ---------- 2+3. 恢复到真实 profile 的临时副本 ----------
const copyProfile = path.join(root, 'profiles', 'desktop');
await fs.cp(realProfileDir, copyProfile, { recursive: true, verbatimSymlinks: true });
// 打乱副本内容，让恢复有活干
await fs.writeFile(path.join(copyProfile, 'cordis.patch.yml'), '# 打乱\n[]\n');
await fs.rm(path.join(copyProfile, 'package.json'));

const restoreEngine = new SyncEngine({ dshHome: root, profileDir: copyProfile, profileName: 'desktop' });
restoreEngine.paths = { ...restoreEngine.paths, config: path.join(root, 'config.json'), state: path.join(root, 'state.json'), log: path.join(root, 'sync.log'), backups: path.join(root, 'backups') };
restoreEngine.store = store;

const dry = await restoreEngine.pull({ dryRun: true });
console.log(`✓ dryRun：将改动 ${dry.changes} 个文件（新增 ${dry.sample.filter((s) => s.action === 'add').length}）`);
assert.ok(dry.changes >= 2);
assert.ok(dry.sample.some((s) => s.path === 'profile/package.json' && s.action === 'add'));

const applied = await restoreEngine.pull({ dryRun: false, confirm: true });
console.log(`✓ 恢复：写入 ${applied.written}，覆盖前备份 ${applied.backedUp}，restartRequired=${applied.restartRequired}`);
const realPatch = await fs.readFile(path.join(realProfileDir, 'cordis.patch.yml'), 'utf8');
const copyPatch = await fs.readFile(path.join(copyProfile, 'cordis.patch.yml'), 'utf8');
assert.equal(copyPatch, realPatch, '恢复后的 cordis.patch.yml 与真机一致');
assert.deepEqual(
  JSON.parse(await fs.readFile(path.join(copyProfile, 'package.json'), 'utf8')),
  JSON.parse(await fs.readFile(path.join(realProfileDir, 'package.json'), 'utf8')),
  'package.json 一致（link 依赖被 merge 保留时除外）',
);

// ---------- 4. 旧格式（0.3.x）兼容：构造含噪声条目的旧快照 ----------
const oldEntries = [
  { path: 'profile/package.json', type: 'file', mode: 0o600, size: 0, sha256: '', data: Buffer.from('{"name":"old","dependencies":{}}') },
  { path: 'profile/.plugin-manager/logs/operation-x/git.log', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('old noise') },
  { path: 'home/cordis.patch.yml', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('- id: legacy\n') },
];
for (const entry of oldEntries) {
  entry.size = entry.data.length;
  entry.sha256 = (await import('node:crypto')).createHash('sha256').update(entry.data).digest('hex');
}
const oldHeader = {
  format: 'dsh-sync/2',
  createdAt: '2026-10-01T00:00:00.000Z',
  device: 'old-machine',
  profile: '旧配置',
  platform: 'win32',
  generator: 'dsh-sync 0.3.4',
  contentHash: 'legacy',
  roots: [
    { id: 'profile', label: 'DSH 配置档案', type: 'dir', path: 'C:\\old\\profile' },
    { id: 'home', label: '用户级 patch', type: 'files', path: 'C:\\old\\home', names: ['cordis.patch.yml'] },
  ],
  counts: { files: 3, dirs: 0, symlinks: 0, bytes: 100 },
  reason: 'manual',
};
const legacyEnvelope = sealArchive(packContainer(oldHeader, oldEntries), PASSPHRASE, { createdAt: oldHeader.createdAt });
const legacyPath = path.join(root, 'legacy.dshsync');
await fs.writeFile(legacyPath, legacyEnvelope);

// 副本先打乱 package.json，保证 package.json 有活干
await fs.writeFile(path.join(copyProfile, 'package.json'), '{"name":"drifted","dependencies":{}}');
const legacyResult = await restoreEngine.pullFromFile(legacyPath, { dryRun: false, confirm: true });
console.log(`✓ 0.3.x 快照：写入 ${legacyResult.written}，告警 ${legacyResult.warnings.length} 条`);
for (const warning of legacyResult.warnings) console.log(`   ⚠ ${warning}`);
assert.ok(legacyResult.warnings.some((w) => w.includes('不在本机当前的备份范围内') && w.includes('DSH 配置档案')), '噪声跳过告警点名模块');
assert.equal(
  await fs.readFile(path.join(copyProfile, 'home', 'cordis.patch.yml').replace(/home$/, 'cordis.patch.yml'), 'utf8').catch(() => null),
  null,
);
// home 模块恢复位置 = dshHome（临时根）下的 cordis.patch.yml
assert.equal(await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8'), '- id: legacy\n');
assert.equal(JSON.parse(await fs.readFile(path.join(copyProfile, 'package.json'), 'utf8')).name, 'old');
assert.ok(!copyPatch.includes('old noise'));

await fs.rm(root, { recursive: true, force: true });
console.log('\n全部真机验证通过 ✓');
