import assert from 'node:assert/strict';

const plugin = await import('../index.js');
assert.equal(typeof plugin.apply, 'function');
assert.deepEqual(plugin.inject, ['tools']);

const tools = await import('../lib/tools.js');
assert.equal(typeof tools.registerTools, 'function');

const engineModule = await import('../lib/engine.js');
assert.equal(typeof engineModule.SyncEngine, 'function');

const configModule = await import('../lib/config.js');
const defaults = configModule.defaultProfile();
assert.equal(defaults.target.kind, 'none');
assert.equal(defaults.schedule.enabled, false);
assert.deepEqual(configModule.targetProblems(defaults).length > 0, true);
assert.deepEqual(configModule.defaultDocument().profiles.length, 1);

const secrets = await import('../lib/secrets.js');
assert.equal(typeof secrets.SecretStore, 'function');

console.log('module smoke test passed');
