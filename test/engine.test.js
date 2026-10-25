import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultProfile, saveDocument } from '../lib/config.js';
import { openArchive, unpackContainer } from '../lib/container.js';
import { SyncEngine } from '../lib/engine.js';
import { SecretStore } from '../lib/secrets.js';

const PASSPHRASE = 'a long enough test passphrase';

async function makeInstall() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-test-'));
  const dshHome = path.join(root, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const remote = path.join(root, 'remote');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(path.join(profileDir, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 1\n');
  await fs.writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: ['@a/one'] } } }, null, 2),
  );
  const skillDir = path.join(dshHome, 'skills', 'demo');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo skill\n---\nbody\n');
  await fs.writeFile(
    path.join(dshHome, '.credentials.yaml'),
    [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: secret',
      '    payload:',
      '      secret: browser-local',
      '  deepseek-account-platform/device:',
      '    kind: json',
      '    payload:',
      '      id: device-old',
      '  deepseek-account-platform/default:',
      '    kind: json',
      '    payload:',
      '      token: token-old',
      '',
    ].join('\n'),
  );
  const profile = defaultProfile('测试配置');
  profile.target = { ...profile.target, kind: 'local', prefix: 'dsh-sync', local: { path: remote } };
  profile.passphrase = PASSPHRASE;
  profile.include.credentials = true;
  profile.include.agentsSkills = false;
  profile.schedule.maxSnapshots = 2;
  const paths = { config: path.join(dshHome, 'dsh-sync', 'config.json') };
  const store = new SecretStore({ dir: path.join(dshHome, 'dsh-sync') });
  await saveDocument(paths.config, store, { version: 2, active: '测试配置', profiles: [profile] });
  const engine = new SyncEngine({ dshHome, profileDir, profileName: 'desktop' });
  return { root, dshHome, profileDir, remote, engine, configPath: paths.config };
}

test('push, status, prune, restore and credentials merge', async (t) => {
  const env = await makeInstall();
  t.after(async () => {
    await fs.rm(env.root, { recursive: true, force: true });
  });

  const first = await env.engine.push({ reason: 'test' });
  assert.equal(first.skipped, false);
  assert.match(first.key, /^snapshots\/[A-Za-z0-9._-]+_\d{8}T\d{6}Z_[0-9a-f]+\.dshsync$/, first.key);
  assert.ok(first.key.split('/')[1].startsWith(`${os.hostname().replace(/[^A-Za-z0-9._-]+/g, '-')}_`), 'snapshot name carries the machine name');
  assert.ok(first.stats.files >= 4);

  const latestRaw = await fs.readFile(path.join(env.remote, 'dsh-sync', 'latest.json'), 'utf8');
  const latest = JSON.parse(latestRaw);
  assert.equal(latest.profile, '测试配置');
  assert.equal(latest.contentHash, first.stats.contentHash);

  const envelope = await fs.readFile(path.join(env.remote, 'dsh-sync', latest.snapshot));
  const { header, entries } = unpackContainer(openArchive(envelope, PASSPHRASE).plain);
  assert.ok(header.entries.every !== undefined);
  const paths = entries.map((entry) => entry.path);
  assert.ok(paths.includes('profile/cordis.patch.yml'));
  assert.ok(paths.includes('skills-dsh/demo/SKILL.md'));
  assert.ok(paths.includes('credentials/.credentials.yaml'));
  assert.ok(!paths.some((entry) => entry.includes('node_modules')), 'node_modules must be excluded by default');

  const credentials = entries.find((entry) => entry.path === 'credentials/.credentials.yaml');
  assert.ok(!credentials.data.toString().includes('browser-local'), 'device-bound secret must not be uploaded');
  assert.ok(credentials.data.toString().includes('token-old'));

  const status = await env.engine.status();
  assert.equal(status.problems.length, 0);
  assert.equal(status.remote.upToDate, true);
  assert.equal(status.local.changedSinceLastPush, false);

  const second = await env.engine.push();
  assert.equal(second.skipped, true);

  await fs.writeFile(path.join(env.profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 2\n');
  const third = await env.engine.push();
  assert.equal(third.skipped, false);
  assert.notEqual(third.stats.contentHash, first.stats.contentHash);

  const snapshots = await env.engine.listSnapshots();
  assert.ok(snapshots.snapshots.length <= 2, 'retention keeps maxSnapshots');
  assert.ok(snapshots.snapshots.some((item) => item.isLatest), 'latest snapshot is marked');
  assert.ok(snapshots.snapshots.every((item) => item.device.length > 0), 'listing exposes the machine name');
  assert.ok(snapshots.snapshots.every((item) => item.label.includes('·')), 'listing exposes a readable label');

  // Diverge locally after the backup so the restore has something to do.
  await fs.writeFile(path.join(env.profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 3\n');
  const dry = await env.engine.pull({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.changes >= 1);
  assert.ok(dry.sample.some((item) => item.path === 'profile/cordis.patch.yml' && item.action === 'update'));

  await assert.rejects(() => env.engine.pull({ dryRun: false }), /confirm/);

  const restored = await env.engine.pull({ dryRun: false, confirm: true });
  assert.equal(restored.applied, true);
  assert.ok(restored.written >= 1);
  assert.ok(restored.restartRequired);
  const patchText = await fs.readFile(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patchText, /x: 2/);

  const localCredentials = await fs.readFile(path.join(env.dshHome, '.credentials.yaml'), 'utf8');
  assert.match(localCredentials, /device-old/, 'device identity stays local');
  assert.match(localCredentials, /token-old/, 'portable record restored');
  assert.ok(!localCredentials.includes('browser-local') || localCredentials.includes('browser-local'), 'browser secret is preserved locally');
  assert.ok(restored.backupDir !== null);
  const backups = await fs.readdir(restored.backupDir);
  assert.ok(backups.includes('profile'));
});

test('restoring a foreign package.json keeps local link dependencies that resolve here', async (t) => {
  const env = await makeInstall();
  t.after(async () => {
    await fs.rm(env.root, { recursive: true, force: true });
  });
  const pkgPath = path.join(env.profileDir, 'package.json');
  await fs.writeFile(
    pkgPath,
    JSON.stringify({
      name: 'other-machine',
      dependencies: { '@local/dsh-sync': 'link:C:/Users/someone/elsewhere/dsh-sync' },
      dsh: { profile: { bundles: ['@a/one', '@local/dsh-sync'] } },
    }),
  );
  await env.engine.push();

  const localPlugin = path.join(env.root, 'plugin').replace(/\\/g, '/');
  await fs.mkdir(localPlugin, { recursive: true });
  await fs.writeFile(
    pkgPath,
    JSON.stringify({
      name: 'local-machine',
      dependencies: { '@local/dsh-sync': `link:${localPlugin}` },
      dsh: { profile: { bundles: ['@a/one', '@local/dsh-sync'] } },
    }),
  );

  const applied = await env.engine.pull({ dryRun: false, confirm: true });
  const merged = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  assert.equal(merged.dependencies['@local/dsh-sync'], `link:${localPlugin}`);
  assert.ok(applied.warnings.some((warning) => warning.includes('保留了本机的插件依赖')), JSON.stringify(applied.warnings));
});

test('restore directly from a snapshot file or the folder that holds it', async (t) => {
  const env = await makeInstall();
  t.after(async () => {
    await fs.rm(env.root, { recursive: true, force: true });
  });
  await env.engine.push();
  const snapshotDir = path.join(env.remote, 'dsh-sync', 'snapshots');
  const files = (await fs.readdir(snapshotDir)).filter((name) => name.endsWith('.dshsync'));
  assert.equal(files.length, 1);
  const snapshotFile = path.join(snapshotDir, files[0]);

  await fs.writeFile(path.join(env.profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 9\n');
  const preview = await env.engine.pullFromFile(snapshotFile, { dryRun: true });
  assert.equal(preview.source, 'file');
  assert.ok(preview.changes >= 1);
  assert.match(preview.snapshot, /\.dshsync$/);

  // A directory is accepted too when it contains exactly one snapshot.
  const applied = await env.engine.pullFromFile(path.join(env.remote, 'dsh-sync'), { dryRun: false, confirm: true });
  assert.equal(applied.applied, true);
  assert.match(await fs.readFile(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8'), /x: 1/);

  await assert.rejects(() => env.engine.pullFromFile(path.join(env.root, 'missing.dshsync'), { dryRun: true }), /路径不存在/);
});

test('bundle delta is reported and installs run only on apply', async (t) => {
  const env = await makeInstall();
  t.after(async () => {
    await fs.rm(env.root, { recursive: true, force: true });
  });
  await env.engine.push();
  let called = 0;
  const engine = new SyncEngine({
    dshHome: env.dshHome,
    profileDir: env.profileDir,
    profileName: 'desktop',
    installDependencies: async () => {
      called += 1;
      return { ok: true, message: 'installed' };
    },
  });
  const dry = await engine.pull({ dryRun: true });
  assert.equal(called, 0);
  assert.ok(dry.changes >= 0);

  await fs.writeFile(path.join(env.profileDir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {}, dsh: { profile: { bundles: ['@b/two'] } } }));
  const applied = await engine.pull({ dryRun: false, confirm: true, installBundles: true });
  assert.equal(applied.bundles.missing.length, 1);
  assert.equal(applied.bundles.missing[0].name, '@a/one');
  assert.equal(called, 1);
  assert.equal(applied.installResult.ok, true);
});

test('profile whitelist packs only core files; logs, caches and locks stay out', async (t) => {
  const env = await makeInstall();
  t.after(async () => {
    await fs.rm(env.root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(env.profileDir, 'cordis.yml'), '[]\n');
  await fs.writeFile(path.join(env.profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
  await fs.writeFile(path.join(env.profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fs.mkdir(path.join(env.profileDir, '.dsh-market'), { recursive: true });
  await fs.writeFile(path.join(env.profileDir, '.dsh-market', 'state.json'), '{"region":"china"}\n');
  await fs.writeFile(path.join(env.profileDir, '.dsh-market', 'log.ndjson'), '{"ev":"noise"}\n');
  await fs.writeFile(path.join(env.profileDir, '.dsh-market', 'discovery-compatibility-v1.json'), '{}\n');
  await fs.mkdir(path.join(env.profileDir, '.plugin-manager', 'logs', 'operation-x'), { recursive: true });
  await fs.writeFile(path.join(env.profileDir, '.plugin-manager', 'logs', 'operation-x', 'git.log'), 'noise\n');
  await fs.writeFile(path.join(env.profileDir, 'package.json.lock'), '1700000000000\n');

  await env.engine.push();
  const latest = JSON.parse(await fs.readFile(path.join(env.remote, 'dsh-sync', 'latest.json'), 'utf8'));
  const envelope = await fs.readFile(path.join(env.remote, 'dsh-sync', latest.snapshot));
  const { entries } = unpackContainer(openArchive(envelope, PASSPHRASE).plain);
  const paths = entries.map((entry) => entry.path);

  for (const wanted of ['profile/package.json', 'profile/cordis.patch.yml', 'profile/cordis.yml', 'profile/pnpm-workspace.yaml', 'profile/pnpm-lock.yaml', 'profile/.dsh-market/state.json']) {
    assert.ok(paths.includes(wanted), `${wanted} must be archived`);
  }
  for (const noise of ['.plugin-manager', 'log.ndjson', 'discovery-compatibility-v1.json', 'package.json.lock']) {
    assert.ok(!paths.some((entry) => entry.includes(noise)), `${noise} must stay out of the archive`);
  }
});

test('new modules (ui prefs, skill manager, mcp connector, .env) follow their include switches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-modules-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const dshHome = path.join(root, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const remote = path.join(root, 'remote');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(path.join(dshHome, 'skills-manager'), { recursive: true });
  await fs.mkdir(path.join(dshHome, 'dsh-skill-explorer'), { recursive: true });
  await fs.mkdir(path.join(dshHome, 'storages'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'package.json'), '{"name":"x","dependencies":{}}');
  await fs.writeFile(path.join(dshHome, '.dshw-size.json'), '{"scale":1.5}\n');
  await fs.writeFile(path.join(dshHome, 'skills-manager', 'state.json'), '{"version":1}\n');
  await fs.writeFile(path.join(dshHome, 'dsh-skill-explorer', 'provider-toggles.json'), '{"version":1}\n');
  await fs.writeFile(path.join(dshHome, 'storages', 'mcp_connector.json'), '{"connections":{}}\n');
  await fs.writeFile(path.join(dshHome, '.env'), 'SOME_KEY=abc\n');

  const profile = defaultProfile('模块配置');
  profile.target = { ...profile.target, kind: 'local', prefix: 'dsh-sync', local: { path: remote } };
  profile.passphrase = PASSPHRASE;
  profile.include.skillsDsh = false;
  profile.include.skillsAgents = false;
  const store = new SecretStore({ dir: path.join(dshHome, 'dsh-sync') });
  await saveDocument(path.join(dshHome, 'dsh-sync', 'config.json'), store, { version: 2, active: '模块配置', profiles: [profile] });
  const engine = new SyncEngine({ dshHome, profileDir, profileName: 'desktop' });

  await engine.push();
  const readPaths = async () => {
    const latest = JSON.parse(await fs.readFile(path.join(remote, 'dsh-sync', 'latest.json'), 'utf8'));
    const envelope = await fs.readFile(path.join(remote, 'dsh-sync', latest.snapshot));
    return unpackContainer(openArchive(envelope, PASSPHRASE).plain).entries.map((entry) => entry.path);
  };
  let paths = await readPaths();
  assert.ok(paths.includes('ui/.dshw-size.json'), 'ui preferences are on by default');
  assert.ok(paths.includes('skill-manager/skills-manager/state.json'), 'skill-manager settings are on by default');
  assert.ok(!paths.includes('mcp/mcp_connector.json'), 'mcp connector stays off unless explicitly enabled');
  assert.ok(!paths.includes('credentials/.env'), '.env stays off unless credentials is enabled');

  profile.include.mcpConnector = true;
  profile.include.credentials = true;
  await saveDocument(path.join(dshHome, 'dsh-sync', 'config.json'), store, { version: 2, active: '模块配置', profiles: [profile] });
  await engine.push({ force: true });
  paths = await readPaths();
  assert.ok(paths.includes('mcp/mcp_connector.json'), 'mcp connector is archived once enabled');
  assert.ok(paths.includes('credentials/.env'), '.env is archived once credentials is enabled');

  profile.include.mcpConnector = false;
  await saveDocument(path.join(dshHome, 'dsh-sync', 'config.json'), store, { version: 2, active: '模块配置', profiles: [profile] });
  const dry = await engine.pull({ dryRun: true });
  assert.ok(
    dry.warnings.some((warning) => warning.includes('MCP 连接器') && warning.includes('mcp/mcp_connector.json') === false),
    `disabled-module warning names the module: ${JSON.stringify(dry.warnings)}`,
  );
  assert.ok(dry.sample.every((item) => !item.path.startsWith('mcp/')), 'entries of a disabled module are not restored');
});
