/** Agent-facing tools. Every tool returns a JSON string rendered as text. */
import { formProfile, saveForm } from './api.js';
import { activeProfile, createProfile, deleteProfile, renameProfile, selectProfile, targetProblems } from './config.js';

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};

function json(value) {
  return JSON.stringify(value, null, 2);
}

/** @param {any} doc */
function profileSummary(doc) {
  const profile = activeProfile(doc);
  return {
    active: doc.active,
    names: doc.profiles.map((item) => item.name),
    profile: formProfile(profile),
    problems: targetProblems(profile),
  };
}

/**
 * Register the sync_* tools on the current context.
 * @param {any} ctx
 * @param {{ engine: any }} deps
 */
export function registerTools(ctx, deps) {
  const { engine } = deps;

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_status',
      description:
        'Show DSH Sync state: the active named sync profile, its cloud target (secrets masked), whether the local profile changed since the last backup, the latest remote snapshot, schedule settings and last errors. Read-only; call this first.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute() {
        return json(await engine.status());
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_configure',
      description:
        'Create or update the ACTIVE named sync profile stored (encrypted) at <DSH_HOME>/dsh-sync/config.json. Merge the given sections: target (kind s3|webdav|local plus credentials), passphrase (archive encryption passphrase; must be 8+ chars with upper, lower, digit and one of @#$*-_ ; may be "env:NAME"), include, schedule, restore, limits. Empty secret fields keep the stored secret. Use sync_profile to create or switch profiles.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'object', description: 'Target block. s3: {endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken, pathStyle}; webdav: {url, username, password, basePath}; local: {path}. Common: {kind, name, prefix}.', additionalProperties: true },
          passphrase: { type: 'string', description: 'Archive encryption passphrase (8+ chars, upper+lower+digit+one of @#$*-_) or env:NAME.' },
          include: { type: 'object', description: 'profile, nodeModules, skills, agentsSkills, credentials, extraPaths[].', additionalProperties: true },
          schedule: { type: 'object', description: 'enabled, intervalMinutes, maxSnapshots.', additionalProperties: true },
          restore: { type: 'object', description: 'installBundles.', additionalProperties: true },
          limits: { type: 'object', description: 'maxFileMB, maxArchiveMB, maxFiles.', additionalProperties: true },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const doc = await saveForm(engine, undefined, args ?? {});
        const summary = profileSummary(doc);
        return json({
          saved: true,
          configPath: engine.paths.config,
          ...summary,
          hint: summary.problems.length === 0 ? '配置完整。接下来可 sync_test 验证连通性，再 sync_push 备份。' : '配置仍不完整；补齐后再 sync_test / sync_push。',
        });
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_profile',
      description:
        'Manage named sync profiles (one per cloud target or machine pairing). Actions: list, create (copies the active profile), select (the active profile is what status/push/pull/schedule use), rename, delete. Deleting the last profile is refused.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'select', 'rename', 'delete'], description: 'Operation.' },
          name: { type: 'string', description: 'Profile name for create/select/delete, or the old name for rename.' },
          newName: { type: 'string', description: 'New name for rename.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const action = args?.action;
        if (action === 'list') {
          return json(profileSummary(await engine.loadDocument()));
        }
        if (action === 'create') {
          const doc = await createProfile(engine.paths.config, engine.store, args?.name);
          return json(profileSummary(doc));
        }
        if (action === 'select') {
          const doc = await selectProfile(engine.paths.config, engine.store, args?.name);
          return json(profileSummary(doc));
        }
        if (action === 'rename') {
          const result = await renameProfile(engine.paths.config, engine.store, args?.name, args?.newName);
          await engine.renameState(result.from, result.to);
          return json(profileSummary(result.doc));
        }
        if (action === 'delete') {
          const doc = await deleteProfile(engine.paths.config, engine.store, args?.name);
          return json(profileSummary(doc));
        }
        throw new Error(`未知操作: ${String(action)}`);
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_test',
      description: 'Verify the active profile storage target: connect, write a probe object, read it back and delete it. Read-only for the profile.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute() {
        const { config, name } = await engine.loadActive();
        const problems = targetProblems(config).filter((problem) => !problem.includes('口令'));
        if (problems.length > 0) return json({ ok: false, profile: name, message: problems.join('；') });
        const backend = engine.backend(config);
        return json({ profile: name, ...(await backend.test()), target: backend.label });
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_push',
      description:
        'Encrypt the current profile state (plugin list, cordis.patch.yml with every plugin setting and MCP server, user skills, optionally credentials/node_modules) and upload a new snapshot to the active profile target, then update latest.json and prune old snapshots. Skips the upload when nothing changed unless force is true.',
      parameters: {
        type: 'object',
        properties: { force: { type: 'boolean', description: 'Upload even when the local content hash matches the latest snapshot.' } },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        return json(await engine.push({ force: args?.force === true, reason: 'manual' }));
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_pull',
      description:
        'Restore a snapshot from the active profile target into this DSH installation. Call once with dryRun (the default) to preview, then with dryRun: false and confirm: true to apply. Existing files are copied to <DSH_HOME>/dsh-sync/backups/<stamp>/ first; local-only files are never deleted. A restore that touches the profile needs a DSH restart.',
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'Preview only. Defaults to true.' },
          confirm: { type: 'boolean', description: 'Required to apply. The user must agree first.' },
          snapshot: { type: 'string', description: 'Snapshot name from sync_snapshots. Defaults to latest.' },
          installBundles: { type: 'boolean', description: 'Reinstall plugin bundles missing on this machine.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        return json(
          await engine.pull({
            dryRun: args?.dryRun !== false,
            confirm: args?.confirm === true,
            snapshot: args?.snapshot,
            installBundles: args?.installBundles,
          }),
        );
      },
    }),
  );

  ctx.effect(() =>
    ctx.tools.register({
      name: 'sync_snapshots',
      description: 'List the snapshots stored under the active profile target prefix, newest first, marking the one latest.json points at.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Maximum rows. Defaults to 30.' } },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        return json(await engine.listSnapshots({ limit: args?.limit }));
      },
    }),
  );
}
