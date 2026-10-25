/** Turn a DSH installation into a deterministic, restorable set of files. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { stripDeviceRecords } from './credentials.js';
import { sha256Hex, walkTree } from './util.js';

/**
 * @typedef {object} RootSpec
 * @property {string} id archive prefix
 * @property {string} label human name
 * @property {'dir'|'files'} type
 * @property {string} path absolute path
 * @property {string[]} [names] for type=files
 * @property {boolean} optional
 * @property {'credentials'} [transform]
 */

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.pnpm-store', '.cache', '__pycache__']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.dsh-sync-probe']);

/**
 * Resolve the concrete directories a snapshot covers.
 * @param {{ dshHome: string, profileDir: string, homedir: string, include: any }} input
 * @returns {RootSpec[]}
 */
export function buildRoots({ dshHome, profileDir, homedir, include }) {
  /** @type {RootSpec[]} */
  const roots = [];
  if (include.profile !== false) {
    roots.push({ id: 'profile', label: 'DSH 配置档案（package.json / cordis.patch.yml / 插件清单）', type: 'dir', path: profileDir, optional: false });
  }
  roots.push({ id: 'home', label: '用户级 patch（~/.dsh/cordis.patch.yml）', type: 'files', path: dshHome, names: ['cordis.patch.yml'], optional: true });
  if (include.skills !== false) {
    roots.push({ id: 'skills-dsh', label: '用户技能 ~/.dsh/skills', type: 'dir', path: path.join(dshHome, 'skills'), optional: true });
  }
  if (include.agentsSkills !== false) {
    roots.push({ id: 'skills-agents', label: '用户技能 ~/.agents/skills', type: 'dir', path: path.join(homedir, '.agents', 'skills'), optional: true });
  }
  if (include.credentials === true) {
    roots.push({ id: 'credentials', label: '登录凭证与 API Key（仅同步非设备绑定记录）', type: 'files', path: dshHome, names: ['.credentials.yaml'], optional: true, transform: 'credentials' });
  }
  const extras = Array.isArray(include.extraPaths) ? include.extraPaths : [];
  extras.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') return;
    const resolved = path.resolve(entry.replace(/^~(?=$|[/\\])/, homedir));
    roots.push({
      id: `extra-${index}`,
      label: `附加目录 ${path.basename(resolved) || resolved}`,
      type: 'dir',
      path: resolved,
      optional: true,
    });
  });
  return roots;
}

/**
 * @param {{ roots: RootSpec[], limits: any, signal?: AbortSignal, includeNodeModules?: boolean }} input
 * @returns {Promise<{ entries: any[], warnings: string[], stats: any }>}
 */
export async function collectSnapshot({ roots, limits, signal, includeNodeModules = false }) {
  const maxFileBytes = Math.max(1, Number(limits?.maxFileMB ?? 16)) * 1024 * 1024;
  const maxArchiveBytes = Math.max(1, Number(limits?.maxArchiveMB ?? 256)) * 1024 * 1024;
  const maxFiles = Math.max(1, Number(limits?.maxFiles ?? 20000));
  const skipDirs = new Set(SKIP_DIRS);
  if (includeNodeModules) skipDirs.delete('node_modules');

  /** @type {any[]} */
  const entries = [];
  /** @type {string[]} */
  const warnings = [];
  let totalBytes = 0;
  let skippedFiles = 0;

  for (const root of roots) {
    /** @type {import('node:fs').Stats | undefined} */
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      if (!root.optional) warnings.push(`来源不存在，已跳过：${root.label}（${root.path}）`);
      continue;
    }

    if (root.type === 'files') {
      for (const name of root.names ?? []) {
        const abs = path.join(root.path, name);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > maxFileBytes) {
          warnings.push(`文件超过 ${limits?.maxFileMB ?? 16}MB，已跳过：${name}`);
          continue;
        }
        let data = await fs.readFile(abs);
        if (root.transform === 'credentials') {
          const text = data.toString('utf8');
          const stripped = stripDeviceRecords(text);
          data = Buffer.from(stripped, 'utf8');
        }
        totalBytes += data.length;
        entries.push({
          path: `${root.id}/${name}`,
          type: 'file',
          mode: stat.mode & 0o777,
          size: data.length,
          sha256: sha256Hex(data),
          data,
        });
      }
      continue;
    }

    if (!rootStat.isDirectory()) continue;
    for await (const item of walkTree(root.path, { skipDirs, skipNames: SKIP_NAMES, signal })) {
      if (item.rel.split('/').some((part) => part === '.git')) continue;
      if (entries.length >= maxFiles) {
        warnings.push(`文件数超过上限 ${maxFiles}，其余文件未纳入快照。可提高 limits.maxFiles。`);
        break;
      }
      const archivePath = `${root.id}/${item.rel}`;
      if (item.kind === 'dir') {
        entries.push({ path: archivePath, type: 'dir', mode: item.mode, size: 0, sha256: '' });
        continue;
      }
      if (item.kind === 'symlink') {
        let link = '';
        try {
          link = await fs.readlink(item.abs);
        } catch {
          continue;
        }
        entries.push({ path: archivePath, type: 'symlink', mode: 0o777, size: 0, sha256: sha256Hex(link), link });
        continue;
      }
      if (item.size > maxFileBytes) {
        skippedFiles += 1;
        warnings.push(`文件超过 ${limits?.maxFileMB ?? 16}MB，已跳过：${archivePath}`);
        continue;
      }
      totalBytes += item.size;
      if (totalBytes > maxArchiveBytes) {
        throw new Error(
          `快照超过 ${limits?.maxArchiveMB ?? 256}MB 上限。可以关闭 node_modules 同步、减少 extraPaths，或提高 limits.maxArchiveMB。`,
        );
      }
      const data = await fs.readFile(item.abs);
      entries.push({
        path: archivePath,
        type: 'file',
        mode: item.mode,
        size: data.length,
        sha256: sha256Hex(data),
        data,
      });
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contentHash = sha256Hex(entries.map((entry) => `${entry.path}\0${entry.type}\0${entry.sha256}\0${entry.size}\n`).join(''));
  const files = entries.filter((entry) => entry.type === 'file').length;
  return {
    entries,
    warnings,
    stats: {
      files,
      dirs: entries.filter((entry) => entry.type === 'dir').length,
      symlinks: entries.filter((entry) => entry.type === 'symlink').length,
      bytes: entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0),
      skippedFiles,
      contentHash,
      roots: roots.map((root) => ({ id: root.id, label: root.label, path: root.path })),
    },
  };
}
