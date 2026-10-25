import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mountApi, registerApi } from '../lib/api.js';
import { SyncEngine } from '../lib/engine.js';

function mockRequest({ method = 'POST', headers = {}, body = '' }) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = headers;
  process.nextTick(() => {
    if (body) request.emit('data', Buffer.from(body, 'utf8'));
    request.emit('end');
  });
  return request;
}

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      this.body = chunk ? chunk.toString('utf8') : '';
      this.done = true;
    },
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-api-'));
  const dshHome = path.join(root, 'dsh');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: a\n  config:\n    x: 1\n');
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
  const engine = new SyncEngine({ dshHome, profileDir, profileName: 'desktop' });
  const server = {
    registered: null,
    register(route) {
      this.registered = route;
      return () => {};
    },
    getOrigin() {
      return 'http://127.0.0.1:9999';
    },
  };
  const ctx = {
    get(name) {
      return name === 'webServer' ? server : undefined;
    },
    effect(fn) {
      return fn();
    },
  };
  registerApi(ctx, engine);
  return { root, engine, server };
}

async function invoke(server, { headers = {}, body = {}, method = 'POST', raw } = {}) {
  const response = mockResponse();
  const request = mockRequest({ method, headers, body: raw ?? JSON.stringify(body) });
  await server.registered.handler(request, response);
  return { status: response.status, value: response.body ? JSON.parse(response.body) : undefined };
}

test('API rejects requests without the DSH Sync header or from another origin', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));

  const forbidden = await invoke(env.server, { body: { action: 'status' } });
  assert.equal(forbidden.status, 403);

  const crossSite = await invoke(env.server, {
    headers: { 'x-dsh-sync': '1', origin: 'https://evil.example' },
    body: { action: 'status' },
  });
  assert.equal(crossSite.status, 403);

  const getMethod = await invoke(env.server, { method: 'GET', headers: { 'x-dsh-sync': '1' }, body: {} });
  assert.equal(getMethod.status, 405);
});

test('API drives status, save, test, push and pull', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const headers = { 'x-dsh-sync': '1', 'content-type': 'application/json' };
  const remote = path.join(env.root, 'remote');

  const initial = await invoke(env.server, { headers, body: { action: 'status' } });
  assert.equal(initial.status, 200);
  assert.equal(initial.value.ok, true);
  assert.ok(initial.value.value.status.problems.length > 0);
  assert.equal(initial.value.value.config.profile.target.kind, 'none');
  assert.deepEqual(initial.value.value.config.names, ['默认配置']);

  const saved = await invoke(env.server, {
    headers,
    body: {
      action: 'config.save',
      payload: {
        target: { kind: 'local', name: 'ui', prefix: 'dsh-sync', local: { path: remote } },
        passphrase: 'Aa1@passphrase',
      },
    },
  });
  assert.equal(saved.value.ok, true, JSON.stringify(saved.value));
  assert.deepEqual(saved.value.value.profile.problems, []);
  assert.equal(saved.value.value.profile.passphraseSet, true);
  assert.ok(!JSON.stringify(saved.value).includes('Aa1@passphrase'), 'passphrase must not round-trip to the page');

  const rejected = await invoke(env.server, {
    headers,
    body: { action: 'config.save', payload: { passphrase: 'weakpass' } },
  });
  assert.equal(rejected.value.ok, false);
  assert.match(rejected.value.error.message, /口令不符合规则/);

  const tested = await invoke(env.server, { headers, body: { action: 'test' } });
  assert.equal(tested.value.value.ok, true, tested.value.value.message);

  const pushed = await invoke(env.server, { headers, body: { action: 'push' } });
  assert.equal(pushed.value.ok, true, JSON.stringify(pushed.value));
  assert.equal(pushed.value.value.skipped, false);

  const status = await invoke(env.server, { headers, body: { action: 'status' } });
  assert.equal(status.value.value.status.remote.upToDate, true);

  const preview = await invoke(env.server, { headers, body: { action: 'pull', payload: { dryRun: true } } });
  assert.equal(preview.value.value.dryRun, true);

  const fromFile = await invoke(env.server, { headers, body: { action: 'pull.file', payload: { path: path.join(env.root, 'remote', 'dsh-sync'), dryRun: true } } });
  assert.equal(fromFile.value.ok, true, JSON.stringify(fromFile.value));
  assert.equal(fromFile.value.value.source, 'file');

  const refused = await invoke(env.server, { headers, body: { action: 'pull', payload: { dryRun: false } } });
  assert.equal(refused.value.ok, false);
  assert.match(refused.value.error.message, /confirm/);

  const snapshots = await invoke(env.server, { headers, body: { action: 'snapshots' } });
  assert.equal(snapshots.value.value.snapshots.length, 1);

  const created = await invoke(env.server, { headers, body: { action: 'profile.create', payload: { name: '公司云' } } });
  assert.equal(created.value.value.active, '公司云');
  assert.deepEqual([...created.value.value.names].sort(), ['公司云', '默认配置'].sort());

  const switched = await invoke(env.server, { headers, body: { action: 'profile.select', payload: { name: '默认配置' } } });
  assert.equal(switched.value.value.active, '默认配置');

  const renamed = await invoke(env.server, { headers, body: { action: 'profile.rename', payload: { from: '公司云', to: '公司备份' } } });
  assert.deepEqual([...renamed.value.value.names].sort(), ['公司备份', '默认配置'].sort());

  const removed = await invoke(env.server, { headers, body: { action: 'profile.delete', payload: { name: '公司备份' } } });
  assert.deepEqual(removed.value.value.names, ['默认配置']);

  const lastOne = await invoke(env.server, { headers, body: { action: 'profile.delete', payload: { name: '默认配置' } } });
  assert.equal(lastOne.value.ok, false);
});

test('modules.preview reports per-module stats and honors include overrides', async (t) => {
  const env = await setup();
  t.after(() => fs.rm(env.root, { recursive: true, force: true }));
  const headers = { 'x-dsh-sync': '1', 'content-type': 'application/json' };

  const preview = await invoke(env.server, { headers, body: { action: 'modules.preview' } });
  assert.equal(preview.value.ok, true, JSON.stringify(preview.value));
  const modules = preview.value.value.modules;
  const byId = Object.fromEntries(modules.map((module) => [module.id, module]));

  assert.equal(byId.profile.required, true);
  assert.equal(byId.profile.enabled, true);
  assert.equal(byId.profile.files, 2, 'whitelisted profile files (package.json + cordis.patch.yml)');
  assert.equal(byId.mcpConnector.defaultOn, false);
  assert.equal(byId.mcpConnector.enabled, false, 'sensitive module stays off by default');
  assert.equal(byId.mcpConnector.present, false, 'storages/mcp_connector.json does not exist in this fixture');
  assert.equal(byId.credentials.sensitive, true);

  const overridden = await invoke(env.server, {
    headers,
    body: { action: 'modules.preview', payload: { include: { mcpConnector: true, skillsDsh: false } } },
  });
  const overriddenById = Object.fromEntries(overridden.value.value.modules.map((module) => [module.id, module]));
  assert.equal(overriddenById.mcpConnector.enabled, true);
  assert.equal(overriddenById.skillsDsh.enabled, false);

  // x-dsh-sync-lang 头切换后端消息语言
  const english = await invoke(env.server, { headers: { ...headers, 'x-dsh-sync-lang': 'en' }, body: { action: 'status' } });
  const problems = english.value.value.status.problems;
  assert.ok(problems.some((problem) => problem.includes('No sync target selected yet')), JSON.stringify(problems));
  const chinese = await invoke(env.server, { headers, body: { action: 'status' } });
  assert.ok(chinese.value.value.status.problems.some((problem) => problem.includes('尚未选择同步目标')), JSON.stringify(chinese.value.value.status.problems));
});

test('mountApi registers now, waits for a late web server, or reports the absence', () => {
  const routes = [];
  const server = {
    register(route) {
      routes.push(route);
      return () => {};
    },
    getOrigin() {
      return 'http://127.0.0.1:1';
    },
  };

  const immediate = {};
  mountApi({ get: (name) => (name === 'webServer' ? server : undefined), effect: (fn) => fn() }, immediate);
  assert.equal(immediate.api.registered, true);
  assert.equal(routes.length, 1);

  const deferred = {};
  let injected = null;
  mountApi(
    {
      get: () => undefined,
      effect: (fn) => fn(),
      inject(deps, callback) {
        injected = deps;
        callback({ get: () => server, effect: (fn) => fn() });
        return () => {};
      },
    },
    deferred,
  );
  assert.deepEqual(injected, ['webServer']);
  assert.equal(deferred.api.registered, true);
  assert.equal(routes.length, 2);

  const absent = {};
  mountApi({ get: () => undefined, effect: (fn) => fn() }, absent);
  assert.equal(absent.api.registered, false);
  assert.match(absent.api.reason, /webServer/);
});
