import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

test('plugin registers its tools and drives a full local round trip', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-plugin-'));
  const dshHome = path.join(root, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  const remote = path.join(root, 'remote');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: demo\n  config:\n    a: 1\n');

  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR };
  process.env.DSH_HOME = dshHome;
  process.env.DSH_PROFILE = 'desktop';
  process.env.DSH_PROFILE_DIR = profileDir;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  /** @type {Map<string, any>} */
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(fn) {
      const disposer = fn();
      disposers.push(disposer);
      return disposer;
    },
    get() {
      return undefined;
    },
  };

  apply(ctx);
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['sync_configure', 'sync_profile', 'sync_pull', 'sync_push', 'sync_snapshots', 'sync_status', 'sync_test'],
  );
  for (const definition of tools.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.deepEqual(definition.output.render({}, 'x'), [{ type: 'text', text: 'x' }]);
  }

  const call = async (name, args = {}) => JSON.parse(await tools.get(name).execute(args, { signal: new AbortController().signal }));

  const before = await call('sync_status');
  assert.ok(before.problems.some((problem) => problem.includes('同步目标')));
  assert.equal(before.target.kind, 'none');
  assert.equal(before.profile.name, '默认配置');

  const configured = await call('sync_configure', {
    target: { kind: 'local', name: 'test-folder', prefix: 'dsh-sync', local: { path: remote } },
    passphrase: 'Aa1@passphrase',
  });
  assert.equal(configured.saved, true);
  assert.deepEqual(configured.problems, []);
  assert.equal(configured.profile.passphraseSet, true);

  const renamed = await call('sync_profile', { action: 'rename', name: '默认配置', newName: '本机测试' });
  assert.equal(renamed.active, '本机测试');

  const created = await call('sync_profile', { action: 'create', name: '备用云' });
  assert.deepEqual([...created.names].sort(), ['备用云', '本机测试'].sort());
  assert.equal(created.active, '备用云');

  const selected = await call('sync_profile', { action: 'select', name: '本机测试' });
  assert.equal(selected.active, '本机测试');

  const tested = await call('sync_test');
  assert.equal(tested.ok, true, tested.message);

  const pushed = await call('sync_push');
  assert.equal(pushed.skipped, false);
  assert.ok(pushed.stats.files >= 2);

  const after = await call('sync_status');
  assert.equal(after.remote.upToDate, true);

  const listed = await call('sync_snapshots');
  assert.equal(listed.snapshots.length, 1);
  assert.equal(listed.snapshots[0].isLatest, true);

  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: demo\n  config:\n    a: 2\n');
  const preview = await call('sync_pull', {});
  assert.equal(preview.dryRun, true);
  assert.ok(preview.changes >= 1);

  for (const disposer of disposers) {
    if (typeof disposer === 'function') await disposer();
  }
});
