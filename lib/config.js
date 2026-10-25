/** Encrypted, named sync profiles plus local state and logs. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describeSecret, nowIso, readJson, resolveSecret, writeJsonAtomic } from './util.js';

export const CONFIG_VERSION = 2;
export const PROFILE_NAME_MAX = 40;
export const DEFAULT_PROFILE = '默认配置';
const FILE_FORMAT = 'dsh-sync-config';

/** @returns {any} */
export function defaultProfile(name = DEFAULT_PROFILE) {
  return {
    name,
    target: {
      kind: 'none',
      name: '',
      prefix: 'dsh-sync',
      s3: { endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', pathStyle: true },
      webdav: { url: '', username: '', password: '', basePath: '' },
      local: { path: '' },
    },
    passphrase: '',
    include: {
      profile: true,
      homePatch: true,
      skillsDsh: true,
      skillsAgents: true,
      uiPrefs: true,
      skillManager: true,
      mcpConnector: false,
      workspaceRoot: false,
      credentials: false,
      nodeModules: false,
      extraPaths: [],
    },
    schedule: { enabled: false, intervalMinutes: 30, maxSnapshots: 10 },
    restore: { installBundles: true },
    limits: { maxFileMB: 16, maxArchiveMB: 256, maxFiles: 20000 },
  };
}

/** @returns {any} */
export function defaultDocument() {
  return { version: CONFIG_VERSION, active: DEFAULT_PROFILE, profiles: [defaultProfile()] };
}

/** @param {string} dshHome */
export function syncPaths(dshHome) {
  const base = path.join(dshHome, 'dsh-sync');
  return {
    base,
    config: path.join(base, 'config.json'),
    state: path.join(base, 'state.json'),
    log: path.join(base, 'sync.log'),
    staging: path.join(base, 'staging'),
    backups: path.join(base, 'backups'),
    tmp: path.join(base, 'tmp'),
  };
}

/** @param {unknown} raw */
export function normalizeProfileName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('配置名称不能为空');
  if (name.length > PROFILE_NAME_MAX) throw new Error(`配置名称不能超过 ${PROFILE_NAME_MAX} 个字符`);
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('配置名称不能包含 \\ / : * ? " < > |');
  return name;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isObject(value) && isObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** include 字段 v0.3（skills / agentsSkills）→ v0.4（skillsDsh / skillsAgents），保留用户原选择。 */
function migrateIncludeKeys(include) {
  if (include.skills !== undefined && include.skillsDsh === undefined) include.skillsDsh = include.skills;
  if (include.agentsSkills !== undefined && include.skillsAgents === undefined) include.skillsAgents = include.agentsSkills;
  delete include.skills;
  delete include.agentsSkills;
}

/** Fill every missing field so runtime code never reads undefined. */
function completeProfile(raw) {
  const base = defaultProfile(typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : DEFAULT_PROFILE);
  // 迁移必须发生在 deepMerge 之前：merge 会用默认值填充新键，之后就无法区分用户显式设置了。
  if (isObject(raw?.include)) migrateIncludeKeys(raw.include);
  const merged = deepMerge(base, raw ?? {});
  merged.name = base.name;
  if (!Array.isArray(merged.include.extraPaths)) merged.include.extraPaths = [];
  return merged;
}

/** @param {any} raw */
function normalizeDocument(raw) {
  const doc = isObject(raw) ? raw : {};
  const profiles = Array.isArray(doc.profiles) && doc.profiles.length > 0 ? doc.profiles.map(completeProfile) : [defaultProfile()];
  const seen = new Set();
  const unique = [];
  for (const profile of profiles) {
    let name = profile.name;
    let suffix = 2;
    while (seen.has(name)) name = `${profile.name} (${suffix++})`;
    seen.add(name);
    unique.push({ ...profile, name });
  }
  const active = unique.some((profile) => profile.name === doc.active) ? doc.active : unique[0].name;
  return { version: CONFIG_VERSION, active, profiles: unique };
}

/** @param {any} raw @returns {any} */
function migrateV1(raw) {
  const profile = completeProfile({
    name: DEFAULT_PROFILE,
    target: raw.target,
    passphrase: raw.passphrase,
    include: raw.include,
    schedule: raw.schedule,
    restore: raw.restore,
    limits: raw.limits,
  });
  return { version: CONFIG_VERSION, active: DEFAULT_PROFILE, profiles: [profile] };
}

/**
 * @param {string} file
 * @param {import('./secrets.js').SecretStore} store
 * @returns {Promise<any>}
 */
export async function loadDocument(file, store) {
  const raw = await readJson(file, null);
  if (!raw) return defaultDocument();
  if (raw.format === FILE_FORMAT && raw.blob) return normalizeDocument(await store.open(raw));
  if (Array.isArray(raw.profiles)) return normalizeDocument(raw);
  const migrated = migrateV1(raw);
  try {
    await saveDocument(file, store, migrated);
  } catch {
    /* A read-only home still gets the migrated document in memory. */
  }
  return normalizeDocument(migrated);
}

/**
 * @param {string} file
 * @param {import('./secrets.js').SecretStore} store
 * @param {any} doc
 */
export async function saveDocument(file, store, doc) {
  const normalized = normalizeDocument(doc);
  const sealed = await store.seal({ version: CONFIG_VERSION, active: normalized.active, profiles: normalized.profiles });
  await writeJsonAtomic(
    file,
    { format: FILE_FORMAT, version: CONFIG_VERSION, cipher: sealed.cipher, blob: sealed.blob },
    { mode: 0o600 },
  );
  return normalized;
}

/** @param {any} doc */
export function activeProfile(doc) {
  return doc.profiles.find((profile) => profile.name === doc.active) ?? doc.profiles[0];
}

/** @param {any} doc @param {string} name */
export function findProfile(doc, name) {
  return doc.profiles.find((profile) => profile.name === name);
}

/** @param {any} doc @returns {string[]} */
export function profileNames(doc) {
  return doc.profiles.map((profile) => profile.name);
}

/**
 * Mutate one profile (creating it when missing) and persist the document.
 * @param {string} file @param {import('./secrets.js').SecretStore} store @param {string} name @param {(profile: any) => void} mutate
 */
export async function updateProfile(file, store, name, mutate) {
  const doc = await loadDocument(file, store);
  const clean = normalizeProfileName(name);
  let profile = findProfile(doc, clean);
  if (!profile) {
    profile = defaultProfile(clean);
    doc.profiles.push(profile);
  }
  mutate(profile);
  profile.name = clean;
  return await saveDocument(file, store, doc);
}

/**
 * @param {string} file @param {import('./secrets.js').SecretStore} store @param {string} name @param {{ from?: string, empty?: boolean }} [options]
 */
export async function createProfile(file, store, name, options = {}) {
  const doc = await loadDocument(file, store);
  const clean = normalizeProfileName(name);
  if (findProfile(doc, clean)) throw new Error(`配置「${clean}」已存在`);
  const source = options.empty ? undefined : findProfile(doc, options.from ?? doc.active);
  const profile = source
    ? completeProfile({ ...structuredClone(source), name: clean, schedule: { ...source.schedule, enabled: false } })
    : defaultProfile(clean);
  profile.name = clean;
  doc.profiles.push(profile);
  doc.active = clean;
  return await saveDocument(file, store, doc);
}

/** @param {string} file @param {import('./secrets.js').SecretStore} store @param {string} name */
export async function selectProfile(file, store, name) {
  const doc = await loadDocument(file, store);
  if (!findProfile(doc, name)) throw new Error(`找不到配置「${name}」`);
  doc.active = name;
  return await saveDocument(file, store, doc);
}

/**
 * @param {string} file @param {import('./secrets.js').SecretStore} store @param {string} from @param {string} to
 * @returns {Promise<{ doc: any, from: string, to: string }>}
 */
export async function renameProfile(file, store, from, to) {
  const doc = await loadDocument(file, store);
  const target = normalizeProfileName(to);
  const profile = findProfile(doc, from);
  if (!profile) throw new Error(`找不到配置「${from}」`);
  if (target !== from && findProfile(doc, target)) throw new Error(`配置「${target}」已存在`);
  profile.name = target;
  if (doc.active === from) doc.active = target;
  const saved = await saveDocument(file, store, doc);
  return { doc: saved, from, to: target };
}

/** @param {string} file @param {import('./secrets.js').SecretStore} store @param {string} name */
export async function deleteProfile(file, store, name) {
  const doc = await loadDocument(file, store);
  if (doc.profiles.length <= 1) throw new Error('至少保留一个配置');
  const index = doc.profiles.findIndex((profile) => profile.name === name);
  if (index < 0) throw new Error(`找不到配置「${name}」`);
  doc.profiles.splice(index, 1);
  if (doc.active === name) doc.active = doc.profiles[0].name;
  return await saveDocument(file, store, doc);
}

/** @param {string} file @returns {Promise<any>} */
export async function loadState(file) {
  return normalizeState((await readJson(file, {})) ?? {});
}

/** @param {any} state */
export function normalizeState(state) {
  if (isObject(state?.profiles)) return { version: 2, profiles: state.profiles };
  /** @type {Record<string, any>} */
  const profiles = {};
  if (state?.lastPush || state?.lastPull || state?.lastAttemptAt) {
    profiles[DEFAULT_PROFILE] = {
      ...(state.lastPush ? { lastPush: state.lastPush } : {}),
      ...(state.lastPull ? { lastPull: state.lastPull } : {}),
      ...(state.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
    };
  }
  return { version: 2, profiles };
}

/** @param {any} state @param {string} name */
export function profileState(state, name) {
  return state.profiles[name] ?? {};
}

/** @param {any} state @param {string} name @param {any} patch */
export function putProfileState(state, name, patch) {
  state.profiles[name] = { ...profileState(state, name), ...patch };
  return state;
}

/** @param {any} state @param {string} from @param {string} to */
export function renameProfileState(state, from, to) {
  if (state.profiles[from] && !state.profiles[to]) {
    state.profiles[to] = state.profiles[from];
    delete state.profiles[from];
  }
  return state;
}

/** @param {string} file @param {any} state */
export async function saveState(file, state) {
  await writeJsonAtomic(file, state, { mode: 0o600 });
}

/** @param {string} file @param {Record<string, unknown>} record */
export async function appendLog(file, record) {
  const line = `${JSON.stringify({ at: nowIso(), ...record })}\n`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat && stat.size > 2 * 1024 * 1024) {
      await fs.rename(file, `${file}.1`).catch(() => undefined);
    }
    await fs.appendFile(file, line, { mode: 0o600 });
  } catch {
    /* Logging is best effort and must never fail a sync. */
  }
}

/** A single profile with its secrets replaced by presence flags. */
export function viewProfile(profile) {
  const target = profile.target ?? {};
  return {
    name: profile.name,
    target: {
      kind: target.kind,
      name: target.name || '',
      prefix: target.prefix,
      ...(target.kind === 's3'
        ? {
            endpoint: target.s3?.endpoint || '(AWS 默认)',
            region: target.s3?.region,
            bucket: target.s3?.bucket,
            pathStyle: target.s3?.pathStyle !== false,
            accessKeyId: target.s3?.accessKeyId ? `${String(target.s3.accessKeyId).slice(0, 4)}****` : '未设置',
            secretAccessKey: describeSecret(target.s3?.secretAccessKey),
            sessionToken: describeSecret(target.s3?.sessionToken),
          }
        : {}),
      ...(target.kind === 'webdav'
        ? {
            url: target.webdav?.url,
            username: target.webdav?.username,
            password: describeSecret(target.webdav?.password),
            basePath: target.webdav?.basePath || '',
          }
        : {}),
      ...(target.kind === 'local' ? { path: target.local?.path } : {}),
    },
    passphrase: describeSecret(profile.passphrase),
    include: profile.include,
    schedule: profile.schedule,
    restore: profile.restore,
    limits: profile.limits,
  };
}

/** @param {any} profile */
export function passphraseOf(profile) {
  return resolveSecret(profile.passphrase);
}

/**
 * @param {any} profile
 * @returns {string[]}
 */
export function targetProblems(profile) {
  const target = profile.target ?? {};
  const problems = [];
  if (target.kind === 's3') {
    if (!target.s3?.bucket) problems.push('S3 bucket 未配置');
    if (!target.s3?.accessKeyId) problems.push('S3 accessKeyId 未配置');
    if (!target.s3?.secretAccessKey) problems.push('S3 secretAccessKey 未配置');
  } else if (target.kind === 'webdav') {
    if (!target.webdav?.url) problems.push('WebDAV url 未配置');
  } else if (target.kind === 'local') {
    if (!target.local?.path) problems.push('本地目录 path 未配置');
  } else {
    problems.push('尚未选择同步目标（target.kind）');
  }
  const passphrase = passphraseOf(profile);
  if (!passphrase) problems.push('同步口令未配置');
  else if (String(passphrase).length < 8) problems.push(`同步口令长度不足 8 位（当前 ${String(passphrase).length} 位），请重新设置`);
  return problems;
}

/** @param {any} prefix */
export function normalizePrefix(prefix) {
  const value = String(prefix ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (value.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`非法的对象前缀: ${prefix}`);
  }
  return value;
}
