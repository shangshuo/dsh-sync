/**
 * Host HTTP API for the settings page.
 *
 * The page is same-origin with the DSH web server, so it posts to `/dsh-sync/api`.
 * Cross-site requests cannot reach the handler: a custom header forces a CORS
 * preflight, and this route never answers one.
 */
import {
  activeProfile,
  createProfile,
  deleteProfile,
  findProfile,
  normalizeProfileName,
  renameProfile,
  selectProfile,
  targetProblems,
  updateProfile,
} from './config.js';
import { setLang, t } from './i18n.js';
import { passphraseProblem } from './passphrase.js';
import { pickPath } from './picker.js';

const PATH = '/dsh-sync/api';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The settings form needs real non-secret values (endpoint, bucket, access key id)
 * and presence flags for the rest.
 * @param {any} profile
 */
export function formProfile(profile) {
  const target = profile.target ?? {};
  return {
    name: profile.name,
    target: {
      kind: target.kind ?? 'none',
      name: target.name ?? '',
      prefix: target.prefix ?? 'dsh-sync',
      s3: {
        endpoint: target.s3?.endpoint ?? '',
        region: target.s3?.region ?? 'auto',
        bucket: target.s3?.bucket ?? '',
        accessKeyId: target.s3?.accessKeyId ?? '',
        pathStyle: target.s3?.pathStyle !== false,
        secretSet: Boolean(target.s3?.secretAccessKey),
        sessionTokenSet: Boolean(target.s3?.sessionToken),
      },
      webdav: {
        url: target.webdav?.url ?? '',
        username: target.webdav?.username ?? '',
        basePath: target.webdav?.basePath ?? '',
        passwordSet: Boolean(target.webdav?.password),
      },
      local: { path: target.local?.path ?? '' },
    },
    passphraseSet: Boolean(profile.passphrase),
    include: profile.include,
    schedule: profile.schedule,
    restore: profile.restore,
    limits: profile.limits,
    problems: targetProblems(profile),
  };
}

/**
 * Turn the settings form into a profile patch. Empty secret fields keep the stored
 * secret instead of clearing it, so a page reload never wipes credentials.
 * @param {any} payload
 */
export function patchFromForm(payload) {
  const target = payload?.target ?? {};
  /** @type {any} */
  const patch = { target: { ...target } };
  if (target.kind === 's3') {
    const s3 = { ...(target.s3 ?? {}) };
    if (!s3.secretAccessKey) delete s3.secretAccessKey;
    if (!s3.sessionToken) delete s3.sessionToken;
    patch.target.s3 = s3;
    delete patch.target.webdav;
    delete patch.target.local;
  } else if (target.kind === 'webdav') {
    const webdav = { ...(target.webdav ?? {}) };
    if (!webdav.password) delete webdav.password;
    patch.target.webdav = webdav;
    delete patch.target.s3;
    delete patch.target.local;
  } else if (target.kind === 'local') {
    patch.target.local = { ...(target.local ?? {}) };
    delete patch.target.s3;
    delete patch.target.webdav;
  }
  if (typeof payload?.passphrase === 'string' && payload.passphrase.length > 0) {
    patch.passphrase = payload.passphrase;
  }
  for (const key of ['include', 'schedule', 'restore', 'limits']) {
    if (payload?.[key] !== undefined) patch[key] = payload[key];
  }
  return patch;
}

/**
 * Apply one form payload onto a named profile.
 * @param {any} engine @param {string | undefined} name @param {any} payload
 */
export async function saveForm(engine, name, payload) {
  if (typeof payload?.passphrase === 'string' && payload.passphrase.length > 0) {
    const problem = passphraseProblem(payload.passphrase);
    if (problem) throw new Error(problem);
  }
  const doc = await engine.loadDocument();
  const targetName = name ? normalizeProfileName(name) : doc.active;
  if (!findProfile(doc, targetName)) throw new Error(`找不到配置「${targetName}」`);
  return await updateProfile(engine.paths.config, engine.store, targetName, (profile) => {
    const patch = patchFromForm(payload);
    if (patch.target) profile.target = { ...profile.target, ...patch.target };
    if (patch.passphrase) profile.passphrase = patch.passphrase;
    for (const key of ['include', 'schedule', 'restore', 'limits']) {
      if (patch[key]) profile[key] = { ...profile[key], ...patch[key] };
    }
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  });
  res.end(body);
}

/** @param {import('node:http').IncomingMessage} req */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(t('请求体超过 1 MB')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error(t('请求体不是合法 JSON')));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {any} ctx
 * @param {any} engine SyncEngine
 */
export function registerApi(ctx, engine) {
  const server = ctx.get('webServer');
  if (!server) return;
  let origin;
  try {
    origin = server.getOrigin();
  } catch {
    origin = undefined;
  }

  const view = async () => {
    const doc = await engine.loadDocument();
    let security = '未知';
    try {
      security = await engine.store.describe();
    } catch {
      /* ignore an unavailable backend */
    }
    return {
      active: doc.active,
      names: doc.profiles.map((profile) => profile.name),
      security,
      profile: formProfile(activeProfile(doc)),
    };
  };

  const handle = async (req, res) => {
    setLang(typeof req.headers['x-dsh-sync-lang'] === 'string' ? req.headers['x-dsh-sync-lang'] : 'zh');
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { message: t('只接受 POST') } });
      return;
    }
    if (req.headers['x-dsh-sync'] !== '1') {
      sendJson(res, 403, { ok: false, error: { message: t('缺少 DSH Sync 请求头') } });
      return;
    }
    if (origin && req.headers.origin && req.headers.origin !== origin) {
      sendJson(res, 403, { ok: false, error: { message: t('跨站请求被拒绝') } });
      return;
    }
    /** @type {any} */
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { message: String(error?.message ?? error) } });
      return;
    }
    const action = body?.action;
    const payload = body?.payload ?? {};
    try {
      switch (action) {
        case 'status': {
          const [status, config] = await Promise.all([engine.status(), view()]);
          sendJson(res, 200, { ok: true, value: { status, config } });
          return;
        }
        case 'config.save': {
          await saveForm(engine, payload?.name, payload);
          sendJson(res, 200, { ok: true, value: await view() });
          return;
        }
        case 'profile.create': {
          await createProfile(engine.paths.config, engine.store, payload?.name, { empty: payload?.empty === true });
          sendJson(res, 200, { ok: true, value: await view() });
          return;
        }
        case 'profile.select': {
          await selectProfile(engine.paths.config, engine.store, payload?.name);
          sendJson(res, 200, { ok: true, value: await view() });
          return;
        }
        case 'profile.rename': {
          const result = await renameProfile(engine.paths.config, engine.store, payload?.from, payload?.to);
          await engine.renameState(result.from, result.to);
          sendJson(res, 200, { ok: true, value: await view() });
          return;
        }
        case 'profile.delete': {
          await deleteProfile(engine.paths.config, engine.store, payload?.name);
          sendJson(res, 200, { ok: true, value: await view() });
          return;
        }
        case 'test': {
          const { config } = await engine.loadActive();
          const problems = targetProblems(config).filter((problem) => !problem.includes('口令'));
          if (problems.length > 0) {
            sendJson(res, 200, { ok: true, value: { ok: false, message: problems.join('；') } });
            return;
          }
          const backend = engine.backend(config);
          sendJson(res, 200, { ok: true, value: await backend.test() });
          return;
        }
        case 'push': {
          sendJson(res, 200, { ok: true, value: await engine.push({ force: payload?.force === true, reason: 'settings-ui' }) });
          return;
        }
        case 'pull': {
          sendJson(res, 200, {
            ok: true,
            value: await engine.pull({ dryRun: payload?.dryRun !== false, confirm: payload?.confirm === true, snapshot: payload?.snapshot }),
          });
          return;
        }
        case 'pull.file': {
          sendJson(res, 200, {
            ok: true,
            value: await engine.pullFromFile(payload?.path, { dryRun: payload?.dryRun !== false, confirm: payload?.confirm === true }),
          });
          return;
        }
        case 'pick.path': {
          sendJson(res, 200, { ok: true, value: await pickPath(payload?.kind === 'folder' ? 'folder' : 'file') });
          return;
        }
        case 'modules.preview': {
          sendJson(res, 200, { ok: true, value: await engine.previewModules(payload?.include) });
          return;
        }
        case 'snapshots': {
          sendJson(res, 200, { ok: true, value: await engine.listSnapshots({ limit: payload?.limit }) });
          return;
        }
        default:
          sendJson(res, 400, { ok: false, error: { message: t('未知操作: {action}', { action: String(action) }) } });
          return;
      }
    } catch (error) {
      sendJson(res, 200, { ok: false, error: { message: String(error?.message ?? error) } });
    }
  };

  ctx.effect(() => server.register({ kind: 'exact', path: PATH, handler: handle }));
  engine.api = { registered: true, path: PATH, origin };
  return { path: PATH, origin };
}

/**
 * Mount the route only once a web server exists. A profile can activate this plugin
 * before the `webServer` service is registered, so wait for it instead of skipping.
 * @param {any} ctx @param {any} engine
 */
export function mountApi(ctx, engine) {
  if (typeof ctx.get === 'function' && ctx.get('webServer')) {
    registerApi(ctx, engine);
    return;
  }
  if (typeof ctx.inject === 'function') {
    engine.api = { registered: false, reason: '等待 webServer 服务' };
    ctx.effect(() =>
      ctx.inject(['webServer'], (inner) => {
        registerApi(inner ?? ctx, engine);
      }),
    );
    return;
  }
  engine.api = { registered: false, reason: '当前运行环境没有 webServer 服务（非 Web 界面）' };
}
