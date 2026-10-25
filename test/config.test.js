import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activeProfile,
  createProfile,
  defaultProfile,
  deleteProfile,
  loadDocument,
  normalizeProfileName,
  renameProfile,
  saveDocument,
  selectProfile,
  updateProfile,
} from '../lib/config.js';
import { SecretStore } from '../lib/secrets.js';

async function makeHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-config-'));
  const dir = path.join(root, 'dsh-sync');
  await fs.mkdir(dir, { recursive: true });
  const store = new SecretStore({ dir });
  await store.init();
  return { root, dir, store, file: path.join(dir, 'config.json') };
}

test('config file holds no plaintext, only an encrypted blob', async (t) => {
  const env = await makeHome();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  const profile = defaultProfile('家里的 R2');
  profile.target = {
    ...profile.target,
    kind: 's3',
    s3: { endpoint: 'https://secret-endpoint.example', region: 'auto', bucket: 'secret-bucket', accessKeyId: 'AKIASECRET', secretAccessKey: 'top-secret-key', pathStyle: true },
  };
  profile.passphrase = 'Aa1@passphrase';
  await saveDocument(env.file, env.store, { version: 2, active: '家里的 R2', profiles: [profile] });

  const text = await fs.readFile(env.file, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'dsh-sync-config');
  assert.ok(parsed.blob.length > 40);
  for (const secret of ['top-secret-key', 'Aa1@passphrase', 'secret-bucket', 'secret-endpoint', 'AKIASECRET']) {
    assert.ok(!text.includes(secret), `config.json must not contain ${secret}`);
  }

  const loaded = await loadDocument(env.file, env.store);
  assert.equal(loaded.active, '家里的 R2');
  assert.equal(activeProfile(loaded).target.s3.secretAccessKey, 'top-secret-key');
  assert.equal(activeProfile(loaded).passphrase, 'Aa1@passphrase');
});

test('a v1 plaintext config is migrated to an encrypted document', async (t) => {
  const env = await makeHome();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await fs.writeFile(
    env.file,
    JSON.stringify({
      version: 1,
      target: { kind: 'local', prefix: 'dsh-sync', local: { path: 'D:\\backup' } },
      passphrase: 'Aa1@passphrase',
      include: { profile: true, credentials: true },
      schedule: { enabled: true, intervalMinutes: 15, maxSnapshots: 3 },
      restore: { installBundles: false },
      limits: { maxFileMB: 4 },
    }),
  );

  const doc = await loadDocument(env.file, env.store);
  assert.equal(doc.version, 2);
  assert.equal(doc.active, '默认配置');
  assert.equal(activeProfile(doc).target.local.path, 'D:\\backup');
  assert.equal(activeProfile(doc).schedule.maxSnapshots, 3);
  assert.equal(activeProfile(doc).include.credentials, true);

  const rewritten = await fs.readFile(env.file, 'utf8');
  assert.ok(!rewritten.includes('D:\\\\backup'));
  assert.equal(JSON.parse(rewritten).format, 'dsh-sync-config');
});

test('named profiles can be created, selected, renamed and deleted', async (t) => {
  const env = await makeHome();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await saveDocument(env.file, env.store, { version: 2, active: '默认配置', profiles: [defaultProfile()] });

  await createProfile(env.file, env.store, '公司云');
  let doc = await loadDocument(env.file, env.store);
  assert.equal(doc.active, '公司云');
  assert.deepEqual([...doc.profiles.map((item) => item.name)].sort(), ['公司云', '默认配置'].sort());

  await selectProfile(env.file, env.store, '默认配置');
  doc = await loadDocument(env.file, env.store);
  assert.equal(doc.active, '默认配置');

  const renamed = await renameProfile(env.file, env.store, '公司云', '公司备份');
  assert.equal(renamed.to, '公司备份');
  doc = await loadDocument(env.file, env.store);
  assert.ok(doc.profiles.some((item) => item.name === '公司备份'));

  await deleteProfile(env.file, env.store, '公司备份');
  doc = await loadDocument(env.file, env.store);
  assert.deepEqual(doc.profiles.map((item) => item.name), ['默认配置']);
  await assert.rejects(() => deleteProfile(env.file, env.store, '默认配置'), /至少保留一个/);
});

test('profile names are validated and updates only touch the named profile', async (t) => {
  const env = await makeHome();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  await saveDocument(env.file, env.store, { version: 2, active: 'A', profiles: [defaultProfile('A'), defaultProfile('B')] });

  await updateProfile(env.file, env.store, 'B', (profile) => {
    profile.schedule.enabled = true;
  });
  const doc = await loadDocument(env.file, env.store);
  assert.equal(doc.profiles.find((item) => item.name === 'B').schedule.enabled, true);
  assert.equal(doc.profiles.find((item) => item.name === 'A').schedule.enabled, false);

  assert.equal(normalizeProfileName('  公司   备份 '), '公司 备份');
  assert.throws(() => normalizeProfileName('   '), /不能为空/);
  assert.throws(() => normalizeProfileName('a/b'), /不能包含/);
  assert.throws(() => normalizeProfileName('x'.repeat(41)), /不能超过/);
});
