/** Small shared helpers: hashing, paths, atomic writes, formatting. */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** @param {string | Buffer | Uint8Array} data */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export const EMPTY_SHA256 = sha256Hex('');

export function nowIso() {
  return new Date().toISOString();
}

/** Compact UTC stamp used in snapshot names: 20260101T120000Z. */
export function utcStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function randomToken(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** @param {string} p */
export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p */
export async function readJson(p, fallback = undefined) {
  try {
    const text = await fs.readFile(p, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      const err = new Error(`${p} is not valid JSON: ${error.message}`);
      err.cause = error;
      throw err;
    }
    throw error;
  }
}

/** Write through a sibling temp file so a crash cannot leave a half-written JSON file. */
export async function writeFileAtomic(target, data, options = {}) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomToken(6)}.tmp`);
  const handle = await fs.open(tmp, 'wx', options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  if (options.mode !== undefined) {
    try {
      await fs.chmod(target, options.mode);
    } catch {
      /* Windows and some filesystems do not support chmod; permissions are best effort. */
    }
  }
}

export async function writeJsonAtomic(target, value, options = {}) {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function fromPosix(p) {
  return p.split('/').join(path.sep);
}

export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * Walk a directory tree without following symlinks.
 * @param {string} root absolute directory
 * @param {{ skipDirs?: Set<string>, skipNames?: Set<string>, signal?: AbortSignal }} options
 * @returns {AsyncGenerator<{ abs: string, rel: string, kind: 'file'|'dir'|'symlink', size: number, mode: number }>}
 */
export async function* walkTree(root, options = {}) {
  const skipDirs = options.skipDirs ?? new Set();
  const skipNames = options.skipNames ?? new Set();
  /** @type {{ dir: string, rel: string }[]} */
  const queue = [{ dir: root, rel: '' }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    options.signal?.throwIfAborted();
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      const abs = path.join(current.dir, entry.name);
      if (skipNames.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        yield { abs, rel, kind: 'symlink', size: 0, mode: 0o777 };
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        yield { abs, rel, kind: 'dir', size: 0, mode: 0o755 };
        queue.push({ dir: abs, rel });
        continue;
      }
      if (entry.isFile()) {
        const stat = await fs.stat(abs);
        yield { abs, rel, kind: 'file', size: stat.size, mode: stat.mode & 0o777 };
      }
    }
  }
}

/** Read a secret that may be stored inline or as `env:NAME`. */
export function resolveSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('env:')) {
    const name = value.slice(4).trim();
    const resolved = process.env[name];
    return resolved && resolved.length > 0 ? resolved : undefined;
  }
  return value;
}

/** Keep a secret useful to a human while never echoing it in full. */
export function describeSecret(value) {
  if (value === undefined || value === null || value === '') return 'unset';
  if (typeof value === 'string' && value.startsWith('env:')) return `环境变量 ${value.slice(4)}`;
  return '已设置';
}
