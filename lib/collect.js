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
 * @property {string[]} [names] for type=files（允许子目录相对路径，如 `.dsh-market/state.json`）
 * @property {boolean} optional
 * @property {'credentials'} [transform]
 * @property {boolean} [sensitive] 隐私模块（含令牌/密钥），UI 需显示隐私声明
 */

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.pnpm-store', '.cache', '__pycache__']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.dsh-sync-probe']);

/** profile 目录白名单：DSH 官方组合机制实际读取的文件；其余（日志/缓存/锁）不入归档。 */
const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.dsh-market/state.json',
];

/**
 * 备份模块元数据：include 的键、默认值与展示信息。
 * include 键名（v0.4）→ 归档前缀的映射见 MODULE_ARCHIVE_PREFIX。
 */
export const SYNC_MODULES = [
  { id: 'profile', label: 'DSH 配置档案', hint: '插件清单与全部插件设置（package.json、cordis.patch.yml、pnpm 配置、市场设置）。恢复后缺失的插件包会自动安装', defaultOn: true, required: true },
  { id: 'homePatch', label: '机器级补丁', hint: '~/.dsh/cordis.patch.yml，对所有 profile 生效的用户层配置', defaultOn: true },
  { id: 'skillsDsh', label: 'DSH 自建技能', hint: '~/.dsh/skills 目录（不存在时自动跳过）', defaultOn: true },
  { id: 'skillsAgents', label: '跨工具技能', hint: '~/.agents/skills 目录，与其它 agent 工具共享', defaultOn: true },
  { id: 'uiPrefs', label: '桌面界面偏好', hint: '窗口缩放、音效、气泡开关等（.dshw-size.json）', defaultOn: true },
  { id: 'skillManager', label: '技能管理器设置', hint: '技能来源开关与禁用列表（skills-manager、dsh-skill-explorer）', defaultOn: true },
  { id: 'mcpConnector', label: 'MCP 连接器（含令牌）', hint: '桌面版 MCP 服务器连接与授权（storages/mcp_connector.json）。文件可能包含访问令牌，默认不备份', defaultOn: false, sensitive: true },
  { id: 'workspaceRoot', label: '工作区根依赖', hint: 'profiles/package.json（含市场插件依赖），一般可由 DSH 重建', defaultOn: false },
  { id: 'credentials', label: '凭证与 API Key', hint: '.credentials.yaml 与 .env。设备绑定记录永远不上传', defaultOn: false, sensitive: true },
  { id: 'nodeModules', label: '插件代码（node_modules）', hint: '离线可还原，体积大；默认靠恢复时自动 pnpm 安装', defaultOn: false },
];

/** include 键 → 归档内前缀。恢复端用它把未启用模块的条目翻译成模块名。 */
export const MODULE_ARCHIVE_PREFIX = {
  profile: 'profile',
  homePatch: 'home',
  skillsDsh: 'skills-dsh',
  skillsAgents: 'skills-agents',
  uiPrefs: 'ui',
  skillManager: 'skill-manager',
  mcpConnector: 'mcp',
  workspaceRoot: 'workspace-root',
  credentials: 'credentials',
  nodeModules: 'node-modules',
};

/** @param {string} archivePrefix */
export function moduleLabelOfPrefix(archivePrefix) {
  const entry = SYNC_MODULES.find((module) => MODULE_ARCHIVE_PREFIX[module.id] === archivePrefix);
  return entry?.label ?? archivePrefix;
}

/**
 * 浅遍历试算每个模块的文件数与体积（不读文件内容、不计算哈希），
 * 供设置页在勾选模块时即时反馈。extraPaths 也参与试算。
 * @param {{ dshHome: string, profileDir: string, homedir: string, include: any }} input
 */
export async function previewModules({ dshHome, profileDir, homedir, include }) {
  const inc = include ?? {};
  const allOn = Object.fromEntries(SYNC_MODULES.map((module) => [module.id, true]));
  const roots = buildRoots({ dshHome, profileDir, homedir, include: { ...allOn, extraPaths: inc.extraPaths ?? [] } });
  const prefixToModule = new Map(SYNC_MODULES.map((module) => [MODULE_ARCHIVE_PREFIX[module.id], module]));
  /** @type {Map<string, { files: number, bytes: number, present: boolean }>} */
  const byPrefix = new Map();
  for (const root of roots) {
    const stat = { files: 0, bytes: 0, present: false };
    byPrefix.set(root.id, stat);
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      continue;
    }
    stat.present = false;
    if (root.type === 'files') {
      for (const name of root.names ?? []) {
        try {
          const fileStat = await fs.stat(path.join(root.path, name));
          if (!fileStat.isFile()) continue;
          stat.present = true;
          stat.files += 1;
          stat.bytes += fileStat.size;
        } catch {
          /* individual optional files may be absent */
        }
      }
      continue;
    }
    if (!rootStat.isDirectory()) continue;
    stat.present = true;
    for await (const item of walkTree(root.path, { skipDirs: SKIP_DIRS, skipNames: SKIP_NAMES })) {
      if (item.kind !== 'file') continue;
      stat.files += 1;
      stat.bytes += item.size;
    }
  }
  const extraPrefixes = [...byPrefix.keys()].filter((prefix) => !prefixToModule.has(prefix));
  return {
    modules: SYNC_MODULES.map((module) => {
      const stat = byPrefix.get(MODULE_ARCHIVE_PREFIX[module.id]) ?? { files: 0, bytes: 0, present: false };
      return {
        id: module.id,
        label: module.label,
        hint: module.hint,
        defaultOn: module.defaultOn === true,
        required: module.required === true,
        sensitive: module.sensitive === true,
        enabled: module.required === true || inc[module.id] === true || (inc[module.id] !== false && module.defaultOn === true),
        ...stat,
      };
    }),
    extras: extraPrefixes.map((prefix) => ({ id: prefix, label: `附加目录`, enabled: true, ...(byPrefix.get(prefix) ?? { files: 0, bytes: 0, present: false }) })),
  };
}

/**
 * Resolve the concrete directories a snapshot covers.
 * @param {{ dshHome: string, profileDir: string, homedir: string, include: any }} input
 * @returns {RootSpec[]}
 */
export function buildRoots({ dshHome, profileDir, homedir, include }) {
  const inc = include ?? {};
  const on = (key) => inc[key] !== false;
  const label = (key) => SYNC_MODULES.find((module) => module.id === key)?.label ?? key;
  /** @type {RootSpec[]} */
  const roots = [];
  if (inc.profile !== false) {
    roots.push({ id: 'profile', label: label('profile'), type: 'files', path: profileDir, names: [...PROFILE_FILES], optional: false });
  }
  if (on('homePatch')) {
    roots.push({ id: 'home', label: label('homePatch'), type: 'files', path: dshHome, names: ['cordis.patch.yml'], optional: true });
  }
  if (on('skillsDsh')) {
    roots.push({ id: 'skills-dsh', label: label('skillsDsh'), type: 'dir', path: path.join(dshHome, 'skills'), optional: true });
  }
  if (on('skillsAgents')) {
    roots.push({ id: 'skills-agents', label: label('skillsAgents'), type: 'dir', path: path.join(homedir, '.agents', 'skills'), optional: true });
  }
  if (on('uiPrefs')) {
    roots.push({ id: 'ui', label: label('uiPrefs'), type: 'files', path: dshHome, names: ['.dshw-size.json'], optional: true });
  }
  if (on('skillManager')) {
    roots.push({
      id: 'skill-manager',
      label: label('skillManager'),
      type: 'files',
      path: dshHome,
      names: ['skills-manager/state.json', 'dsh-skill-explorer/provider-toggles.json'],
      optional: true,
    });
  }
  if (inc.mcpConnector === true) {
    roots.push({ id: 'mcp', label: label('mcpConnector'), type: 'files', path: path.join(dshHome, 'storages'), names: ['mcp_connector.json'], optional: true, sensitive: true });
  }
  if (inc.workspaceRoot === true) {
    roots.push({ id: 'workspace-root', label: label('workspaceRoot'), type: 'files', path: path.dirname(profileDir), names: ['package.json'], optional: true });
  }
  if (inc.credentials === true) {
    roots.push({ id: 'credentials', label: label('credentials'), type: 'files', path: dshHome, names: ['.credentials.yaml', '.env'], optional: true, transform: 'credentials', sensitive: true });
  }
  if (inc.nodeModules === true) {
    roots.push({ id: 'node-modules', label: label('nodeModules'), type: 'dir', path: path.join(profileDir, 'node_modules'), optional: true });
  }
  const extras = Array.isArray(inc.extraPaths) ? inc.extraPaths : [];
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
 * @param {{ roots: RootSpec[], limits: any, signal?: AbortSignal }} input
 * @returns {Promise<{ entries: any[], warnings: string[], stats: any }>}
 */
export async function collectSnapshot({ roots, limits, signal }) {
  const maxFileBytes = Math.max(1, Number(limits?.maxFileMB ?? 16)) * 1024 * 1024;
  const maxArchiveBytes = Math.max(1, Number(limits?.maxArchiveMB ?? 256)) * 1024 * 1024;
  const maxFiles = Math.max(1, Number(limits?.maxFiles ?? 20000));
  const skipDirs = new Set(SKIP_DIRS);

  /** @type {any[]} */
  const entries = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, any>} */
  const rootStats = new Map();
  let totalBytes = 0;
  let skippedFiles = 0;

  for (const root of roots) {
    const stat = { id: root.id, label: root.label, path: root.path, sensitive: root.sensitive === true, optional: root.optional !== false, present: false, files: 0, bytes: 0 };
    rootStats.set(root.id, stat);
    /** @type {import('node:fs').Stats | undefined} */
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      if (!root.optional) warnings.push(`来源不存在，已跳过：${root.label}（${root.path}）`);
      continue;
    }
    stat.present = root.type === 'dir';

    if (root.type === 'files') {
      for (const name of root.names ?? []) {
        const abs = path.join(root.path, name);
        let fileStat;
        try {
          fileStat = await fs.stat(abs);
        } catch {
          continue;
        }
        stat.present = true;
        if (!fileStat.isFile()) continue;
        if (fileStat.size > maxFileBytes) {
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
        stat.files += 1;
        stat.bytes += data.length;
        entries.push({
          path: `${root.id}/${name}`,
          type: 'file',
          mode: fileStat.mode & 0o777,
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
      stat.files += 1;
      stat.bytes += item.size;
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
      roots: [...rootStats.values()],
    },
  };
}
