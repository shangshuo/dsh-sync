/** Turn a DSH installation into a deterministic, restorable set of files. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { t } from './i18n.js';
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
 * @property {string} [mount] 归档内挂载前缀（替代 id 做路径前缀）；同一 id 的多个 root
 *   可挂到不同子目录（本地插件每个插件一个 root，全部挂到 local-plugins/<编码名> 下）
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
  { id: 'localPlugins', label: '本地目录插件', hint: '以 link:/file: 方式安装的非市场插件源码（不含各自的 node_modules）。恢复时自动释放并重新链接，无需手工重装——代价是备份体积相应增大', defaultOn: true },
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
  localPlugins: 'local-plugins',
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
  return entry ? t(entry.label) : archivePrefix;
}

/**
 * stat-only 全量遍历试算每个模块的文件数与体积（不读文件内容、不计算哈希；
 * 超过 limits.maxFileMB 的文件不计入，与真实采集口径对齐）。
 * 统计范围固定为全部模块（决策依据：勾选开关不改变本机有什么，只改变要不要
 * 备份，全量口径让用户在关闭某模块前也能看到"会跳过多大的内容"）。
 * extraPaths 也参与试算。
 * @param {{ dshHome: string, profileDir: string, homedir: string, include: any, limits?: any, localPlugins?: { name: string, dir: string }[] }} input
 */
export async function previewModules({ dshHome, profileDir, homedir, include, limits, localPlugins }) {
  const inc = include ?? {};
  const maxFileBytes = Math.max(1, Number(limits?.maxFileMB ?? 16)) * 1024 * 1024;
  const nodeModulesSkipDirs = new Set(SKIP_DIRS);
  nodeModulesSkipDirs.delete('node_modules');
  const allOn = Object.fromEntries(SYNC_MODULES.map((module) => [module.id, true]));
  const roots = buildRoots({ dshHome, profileDir, homedir, include: { ...allOn, extraPaths: inc.extraPaths ?? [] }, localPlugins });
  const prefixToModule = new Map(SYNC_MODULES.map((module) => [MODULE_ARCHIVE_PREFIX[module.id], module]));
  /** @type {Map<string, { files: number, bytes: number, present: boolean }>} */
  const byPrefix = new Map();
  for (const root of roots) {
    let stat = byPrefix.get(root.id);
    if (!stat) {
      stat = { files: 0, bytes: 0, present: false };
      byPrefix.set(root.id, stat);
    }
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      continue;
    }
    if (root.type === 'files') {
      for (const name of root.names ?? []) {
        try {
          const fileStat = await fs.stat(path.join(root.path, name));
          if (!fileStat.isFile() || fileStat.size > maxFileBytes) continue;
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
    // 与 collectSnapshot 同口径：node-modules 模块不跳过嵌套 node_modules
    const rootSkipDirs = root.id === 'node-modules' ? nodeModulesSkipDirs : SKIP_DIRS;
    for await (const item of walkTree(root.path, { skipDirs: rootSkipDirs, skipNames: SKIP_NAMES })) {
      if (item.kind !== 'file' || item.size > maxFileBytes) continue;
      stat.files += 1;
      stat.bytes += item.size;
    }
  }
  const extraPrefixes = [...byPrefix.keys()].filter((prefix) => !prefixToModule.has(prefix));
  const extraLabels = new Map(roots.filter((root) => !prefixToModule.has(root.id)).map((root) => [root.id, root.label]));
  return {
    modules: SYNC_MODULES.map((module) => {
      const stat = byPrefix.get(MODULE_ARCHIVE_PREFIX[module.id]) ?? { files: 0, bytes: 0, present: false };
      return {
        id: module.id,
        label: t(module.label),
        hint: t(module.hint),
        defaultOn: module.defaultOn === true,
        required: module.required === true,
        sensitive: module.sensitive === true,
        enabled: module.required === true || inc[module.id] === true || (inc[module.id] !== false && module.defaultOn === true),
        ...stat,
      };
    }),
    extras: extraPrefixes.map((prefix) => ({ id: prefix, label: t(extraLabels.get(prefix) ?? '附加目录'), enabled: true, ...(byPrefix.get(prefix) ?? { files: 0, bytes: 0, present: false }) })),
  };
}

/**
 * Resolve the concrete directories a snapshot covers.
 * @param {{ dshHome: string, profileDir: string, homedir: string, include: any, localPlugins?: { name: string, dir: string }[] }} input
 * @returns {RootSpec[]}
 */
export function buildRoots({ dshHome, profileDir, homedir, include, localPlugins }) {
  const inc = include ?? {};
  const on = (key) => inc[key] !== false;
  const label = (key) => {
    const entry = SYNC_MODULES.find((module) => module.id === key);
    return entry ? t(entry.label) : key;
  };
  /** @type {RootSpec[]} */
  const roots = [];
  if (inc.profile !== false) {
    roots.push({ id: 'profile', label: label('profile'), type: 'files', path: profileDir, names: [...PROFILE_FILES], optional: false });
  }
  if (on('localPlugins')) {
    for (const plugin of localPlugins ?? []) {
      // 每个本地插件一个 root，全部挂到 local-plugins/<URL 编码的插件名> 下；
      // 插件名（如 @local/dsh-sync）经 encodeURIComponent 后不含裸斜杠，可作单一路径段。
      roots.push({ id: 'local-plugins', label: label('localPlugins'), type: 'dir', path: plugin.dir, optional: true, mount: `local-plugins/${encodeURIComponent(plugin.name)}` });
    }
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
      label: t('附加目录 {name}', { name: path.basename(resolved) || resolved }),
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
  // node-modules 模块本身就是要备份插件代码的，遍历它时不跳过嵌套的 node_modules
  // （pnpm 目录结构里依赖的依赖住在这里）；与 0.3 includeNodeModules 的行为一致。
  const nodeModulesSkipDirs = new Set(SKIP_DIRS);
  nodeModulesSkipDirs.delete('node_modules');

  /** @type {any[]} */
  const entries = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, any>} */
  const rootStats = new Map();
  let totalBytes = 0;
  let skippedFiles = 0;

  for (const root of roots) {
    // 同一 id 的多个 root（如每个本地插件一个 root）聚合到同一条统计上。
    let stat = rootStats.get(root.id);
    if (!stat) {
      stat = { id: root.id, label: root.label, path: root.path, sensitive: root.sensitive === true, optional: root.optional !== false, present: false, files: 0, bytes: 0 };
      rootStats.set(root.id, stat);
    }
    /** @type {import('node:fs').Stats | undefined} */
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch {
      if (!root.optional) warnings.push(t('来源不存在，已跳过：{label}（{path}）', { label: root.label, path: root.path }));
      continue;
    }
    stat.present = root.type === 'dir';

    // mount 优先于 id 作为归档内路径前缀。
    const basePrefix = root.mount ?? root.id;
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
          warnings.push(t('文件超过 {limit}，已跳过：{name}', { limit: `${limits?.maxFileMB ?? 16}MB`, name }));
          continue;
        }
        if (entries.length >= maxFiles) {
          warnings.push(t('文件数超过上限 {n}，其余文件未纳入快照。可提高 limits.maxFiles。', { n: maxFiles }));
          break;
        }
        let data = await fs.readFile(abs);
        if (root.transform === 'credentials') {
          const text = data.toString('utf8');
          const stripped = stripDeviceRecords(text);
          data = Buffer.from(stripped, 'utf8');
        }
        totalBytes += data.length;
        if (totalBytes > maxArchiveBytes) {
          throw new Error(
            t('快照超过 {limit} 上限。可以关闭 node_modules 同步、减少 extraPaths，或提高 limits.maxArchiveMB。', { limit: `${limits?.maxArchiveMB ?? 256}MB` }),
          );
        }
        stat.files += 1;
        stat.bytes += data.length;
        entries.push({
          path: `${basePrefix}/${name}`,
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
    const rootSkipDirs = root.id === 'node-modules' ? nodeModulesSkipDirs : skipDirs;
    for await (const item of walkTree(root.path, { skipDirs: rootSkipDirs, skipNames: SKIP_NAMES, signal })) {
      if (item.rel.split('/').some((part) => part === '.git')) continue;
      if (entries.length >= maxFiles) {
        warnings.push(t('文件数超过上限 {n}，其余文件未纳入快照。可提高 limits.maxFiles。', { n: maxFiles }));
        break;
      }
      const archivePath = `${basePrefix}/${item.rel}`;
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
        warnings.push(t('文件超过 {limit}，已跳过：{name}', { limit: `${limits?.maxFileMB ?? 16}MB`, name: archivePath }));
        continue;
      }
      totalBytes += item.size;
      stat.files += 1;
      stat.bytes += item.size;
      if (totalBytes > maxArchiveBytes) {
        throw new Error(
          t('快照超过 {limit} 上限。可以关闭 node_modules 同步、减少 extraPaths，或提高 limits.maxArchiveMB。', { limit: `${limits?.maxArchiveMB ?? 256}MB` }),
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
