/** Local-folder backend: iCloud Drive / OneDrive / Syncthing / NAS mount / USB drive. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { t } from '../i18n.js';
import { formatBytes } from '../util.js';

/** One directory tree used as a "remote" store. */
export class LocalBackend {
  /** @param {any} localConfig @param {string} prefix */
  constructor(localConfig, prefix) {
    this.kind = 'local';
    this.prefix = prefix;
    if (!localConfig?.path) throw new Error(t('本地目录同步目标缺少 path'));
    this.root = path.resolve(String(localConfig.path).replace(/^~(?=$|[/\\])/, process.env.USERPROFILE ?? process.env.HOME ?? '~'));
    this.base = this.prefix ? path.join(this.root, ...this.prefix.split('/')) : this.root;
  }

  get label() {
    return `本地目录 ${this.root}`;
  }

  /** @param {string} key */
  resolve(key) {
    const parts = String(key).replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.some((part) => part === '..' || part === '.')) throw new Error(t('非法的对象键: {key}', { key }));
    const abs = path.join(this.base, ...parts);
    const relative = path.relative(this.root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(t('对象键越界: {key}', { key }));
    return abs;
  }

  /** @param {string} key */
  async put(key, bytes) {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, target);
    return { bytes: bytes.length };
  }

  /** @param {string} key */
  async get(key) {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** @param {string} key */
  async head(key) {
    try {
      const stat = await fs.stat(this.resolve(key));
      return { size: stat.size, lastModified: stat.mtime.toISOString() };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** @param {string} key */
  async list(key) {
    const dir = path.join(this.base, ...String(key).replace(/^\/+/, '').split('/').filter(Boolean));
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      out.push({ key: entry.name, size: stat.size, lastModified: stat.mtime.toISOString() });
    }
    return out;
  }

  /** @param {string} key */
  async delete(key) {
    await fs.rm(this.resolve(key), { force: true });
  }

  async test() {
    try {
      await fs.mkdir(this.base, { recursive: true });
      const probe = this.resolve('.dsh-sync-probe');
      await fs.writeFile(probe, `probe ${new Date().toISOString()}`);
      const stat = await fs.stat(probe);
      await fs.rm(probe, { force: true });
      return { ok: true, message: t('已连接 {label}，目录 {path} 可读写（探测文件 {size}）。', { label: this.label, path: this.base, size: formatBytes(stat.size) }) };
    } catch (error) {
      return { ok: false, message: t('连接 {label} 失败: {message}', { label: this.label, message: error.message }) };
    }
  }
}
