/** Snapshot push / restore pull orchestration over named, encrypted profiles. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from './backends/index.js';
import { buildRoots, collectSnapshot, moduleLabelOfPrefix, previewModules } from './collect.js';
import {
  activeProfile,
  appendLog,
  loadDocument,
  loadState,
  passphraseOf,
  profileState,
  putProfileState,
  renameProfileState,
  saveDocument,
  saveState,
  syncPaths,
  targetProblems,
  viewProfile,
} from './config.js';
import { openArchive, packContainer, sealArchive, unpackContainer } from './container.js';
import { mergeCredentialRecords } from './credentials.js';
import { SecretStore } from './secrets.js';
import { formatBytes, fromPosix, nowIso, pathExists, randomToken, sha256Hex, utcStamp, writeFileAtomic } from './util.js';

const GENERATOR = 'dsh-sync 0.3.6';
const LATEST_KEY = 'latest.json';
const SNAPSHOT_DIR = 'snapshots';

/** @param {string} value @returns {string[]} */
function assertSafeArchivePath(value) {
  const parts = String(value).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`归档内包含非法路径: ${value}`);
  }
  return parts;
}

export class SyncEngine {
  /**
   * @param {{ dshHome: string, profileDir: string, profileName: string, homedir?: string, hostname?: string, installDependencies?: (input: { profileDir: string }) => Promise<{ ok: boolean, message: string }> }} options
   */
  constructor(options) {
    this.dshHome = options.dshHome;
    this.profileDir = options.profileDir;
    this.profileName = options.profileName;
    this.homedir = options.homedir ?? os.homedir();
    this.hostname = options.hostname ?? os.hostname();
    this.installDependencies = options.installDependencies;
    this.paths = syncPaths(this.dshHome);
    this.store = new SecretStore({ dir: this.paths.base });
  }

  async loadDocument() {
    return loadDocument(this.paths.config, this.store);
  }

  async saveDocument(doc) {
    return saveDocument(this.paths.config, this.store, doc);
  }

  /** The active profile plus the document that holds every named profile. */
  async loadActive() {
    const doc = await this.loadDocument();
    return { doc, name: doc.active, config: activeProfile(doc) };
  }

  async loadState() {
    return loadState(this.paths.state);
  }

  async saveState(state) {
    await saveState(this.paths.state, state);
  }

  /** @param {any} config */
  backend(config) {
    return createBackend(config);
  }

  /** @param {any} config */
  roots(config) {
    return buildRoots({
      dshHome: this.dshHome,
      profileDir: this.profileDir,
      homedir: this.homedir,
      include: config.include ?? {},
    });
  }

  /** @param {any} config @param {{ signal?: AbortSignal }} [options] */
  async snapshot(config, options = {}) {
    return await collectSnapshot({
      roots: this.roots(config),
      limits: config.limits,
      signal: options.signal,
    });
  }

  /**
   * 按给定 include（或当前配置）做 stat-only 遍历，试算各模块的文件数与体积。
   * @param {any} [includeOverride] 设置页表单的 include 草稿；缺省用当前配置
   */
  async previewModules(includeOverride) {
    const { config } = await this.loadActive();
    return await previewModules({
      dshHome: this.dshHome,
      profileDir: this.profileDir,
      homedir: this.homedir,
      include: includeOverride ?? config.include,
      limits: config.limits,
    });
  }

  /**
   * Back up the active profile's current state.
   * @param {{ force?: boolean, reason?: string }} [options]
   */
  async push(options = {}) {
    const { name, config } = await this.loadActive();
    const problems = targetProblems(config);
    if (problems.length > 0) throw new Error(`配置「${name}」还不完整：${problems.join('；')}`);
    const backend = this.backend(config);
    const state = await this.loadState();
    const previous = profileState(state, name);
    const collected = await this.snapshot(config);
    const { stats } = collected;

    if (!options.force) {
      const remoteLatest = await this.readLatest(backend).catch(() => null);
      const sameAsRemote = remoteLatest?.contentHash === stats.contentHash && remoteLatest?.profile === name;
      const sameAsLocal = previous.lastPush?.contentHash === stats.contentHash;
      if (sameAsRemote && sameAsLocal) {
        return {
          skipped: true,
          profile: name,
          reason: '内容与上次备份完全一致，未上传新快照。',
          contentHash: stats.contentHash,
          stats,
        };
      }
    }

    const passphrase = passphraseOf(config);
    const header = {
      createdAt: nowIso(),
      device: this.hostname,
      profile: name,
      platform: process.platform,
      generator: GENERATOR,
      contentHash: stats.contentHash,
      roots: stats.roots,
      counts: { files: stats.files, dirs: stats.dirs, symlinks: stats.symlinks, bytes: stats.bytes },
      reason: options.reason ?? 'manual',
    };
    const plain = packContainer(header, collected.entries);
    const envelope = sealArchive(plain, passphrase, { createdAt: header.createdAt, label: `${this.hostname}/${name}` });
    const key = `${SNAPSHOT_DIR}/${sanitizeDevice(this.hostname)}_${utcStamp()}_${randomToken(2)}.dshsync`;
    await backend.put(key, envelope, 'application/octet-stream');
    const archiveSha256 = sha256Hex(envelope);
    const latest = {
      format: 'dsh-sync/2',
      createdAt: header.createdAt,
      device: this.hostname,
      profile: name,
      platform: process.platform,
      snapshot: key,
      contentHash: stats.contentHash,
      archiveSha256,
      bytes: envelope.length,
      files: stats.files,
      dirs: stats.dirs,
      generator: GENERATOR,
    };
    await backend.put(LATEST_KEY, Buffer.from(`${JSON.stringify(latest, null, 2)}\n`, 'utf8'), 'application/json');

    let pruned = 0;
    try {
      pruned = await this.prune(backend, config, key);
    } catch {
      /* pruning is best effort */
    }

    await this.saveState(
      putProfileState(state, name, {
        lastPush: {
          at: header.createdAt,
          key,
          contentHash: stats.contentHash,
          bytes: envelope.length,
          files: stats.files,
          archiveSha256,
        },
      }),
    );
    await appendLog(this.paths.log, {
      op: 'push',
      profile: name,
      key,
      bytes: envelope.length,
      files: stats.files,
      contentHash: stats.contentHash,
      pruned,
    });
    return { skipped: false, profile: name, key, bytes: envelope.length, stats, warnings: collected.warnings, pruned };
  }

  /** @param {any} backend */
  async readLatest(backend) {
    const bytes = await backend.get(LATEST_KEY);
    if (!bytes) return null;
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
  }

  /** @param {any} backend @param {any} config @param {string} keepKey */
  async prune(backend, config, keepKey) {
    const limit = Math.max(1, Number(config.schedule?.maxSnapshots ?? 10));
    const listed = await backend.list(`${SNAPSHOT_DIR}/`);
    const names = listed
      .filter((item) => snapshotName(item.key).endsWith('.dshsync'))
      .sort((a, b) => {
        const left = snapshotTime(a);
        const right = snapshotTime(b);
        if (left === right) return a.key < b.key ? -1 : 1;
        return left < right ? -1 : 1;
      })
      .map((item) => snapshotName(item.key));
    if (names.length <= limit) return 0;
    const removable = names.slice(0, names.length - limit).filter((name) => `${SNAPSHOT_DIR}/${name}` !== keepKey);
    let removed = 0;
    for (const name of removable) {
      await backend.delete(`${SNAPSHOT_DIR}/${name}`);
      removed += 1;
    }
    return removed;
  }

  /** @param {{ limit?: number }} [options] */
  async listSnapshots(options = {}) {
    const { name, config } = await this.loadActive();
    const backend = this.backend(config);
    const latest = await this.readLatest(backend);
    const listed = await backend.list(`${SNAPSHOT_DIR}/`);
    const limit = Math.max(1, Number(options.limit ?? 30));
    return {
      profile: name,
      target: backend.label,
      latest,
      snapshots: listed
        .filter((item) => snapshotName(item.key).endsWith('.dshsync'))
        .sort((a, b) => {
          const left = snapshotTime(a);
          const right = snapshotTime(b);
          if (left === right) return a.key < b.key ? 1 : -1;
          return left < right ? 1 : -1;
        })
        .slice(0, limit)
        .map((item) => {
          const snapshot = snapshotName(item.key);
          const key = `${SNAPSHOT_DIR}/${snapshot}`;
          const parsed = parseSnapshotName(snapshot);
          return {
            name: snapshot,
            key,
            device: parsed?.device ?? '',
            at: parsed ? parsed.at : item.lastModified,
            label: `${parsed?.device || '未知设备'} · ${parsed ? formatLocal(parsed.at) : item.lastModified ?? ''}`,
            size: formatBytes(item.size),
            bytes: item.size,
            isLatest: latest?.snapshot === key,
          };
        }),
    };
  }

  /**
   * Restore one snapshot (default: the latest) into this installation.
   * @param {{ dryRun?: boolean, snapshot?: string, confirm?: boolean, installBundles?: boolean, verify?: boolean }} [options]
   */
  async pull(options = {}) {
    const dryRun = options.dryRun !== false;
    if (!dryRun && options.confirm !== true) {
      throw new Error('恢复会覆盖本机配置。请先以 dryRun（默认）预览，再带 confirm: true 重试。');
    }
    const { name, config } = await this.loadActive();
    const problems = targetProblems(config);
    if (problems.length > 0) throw new Error(`配置「${name}」还不完整：${problems.join('；')}`);
    const backend = this.backend(config);
    const state = await this.loadState();
    const latest = await this.readLatest(backend);
    const key = options.snapshot ? (options.snapshot.includes('/') ? options.snapshot : `${SNAPSHOT_DIR}/${options.snapshot}`) : latest?.snapshot;
    if (!key) throw new Error('远端没有找到快照：先执行一次备份，或用 sync_snapshots 查看。');

    const maxBytes = Math.max(1, Number(config.limits?.maxArchiveMB ?? 256)) * 1024 * 1024;
    const envelope = await backend.get(key);
    if (!envelope) throw new Error(`快照不存在: ${key}`);
    if (envelope.length > maxBytes) throw new Error(`快照 ${formatBytes(envelope.length)} 超过上限，已拒绝下载。`);
    if (latest?.snapshot === key && latest.archiveSha256 && sha256Hex(envelope) !== latest.archiveSha256) {
      throw new Error('快照与 latest.json 记录的校验值不一致（下载损坏或被篡改）。');
    }
    return await this.restoreEnvelope(envelope, key, { ...options, name, config, state, source: 'remote' });
  }

  /**
   * Restore a snapshot the user picked on disk: a `.dshsync` file, or a folder that
   * holds one (the folder may be a target root, its `snapshots` dir, or an unzipped copy).
   * @param {string} inputPath
   * @param {{ dryRun?: boolean, confirm?: boolean, installBundles?: boolean, verify?: boolean }} [options]
   */
  async pullFromFile(inputPath, options = {}) {
    const dryRun = options.dryRun !== false;
    if (!dryRun && options.confirm !== true) {
      throw new Error('恢复会覆盖本机配置。请先以 dryRun（默认）预览，再带 confirm: true 重试。');
    }
    const { name, config } = await this.loadActive();
    const problems = targetProblems(config);
    if (problems.length > 0) throw new Error(`配置「${name}」还不完整：${problems.join('；')}`);
    const file = await resolveSnapshotFile(inputPath);
    const maxBytes = Math.max(1, Number(config.limits?.maxArchiveMB ?? 256)) * 1024 * 1024;
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) throw new Error(`快照 ${formatBytes(stat.size)} 超过上限，已拒绝读取。`);
    const envelope = await fs.readFile(file);
    const state = await this.loadState();
    return await this.restoreEnvelope(envelope, file, { ...options, name, config, state, source: 'file' });
  }

  /**
   * @param {Buffer} envelope
   * @param {string} key display key (remote object key or absolute file path)
   * @param {{ name: string, config: any, state: any, source: 'remote'|'file', dryRun?: boolean, installBundles?: boolean, verify?: boolean }} ctx
   */
  async restoreEnvelope(envelope, key, ctx) {
    const { name, config, state, source } = ctx;
    const dryRun = ctx.dryRun !== false;
    const passphrase = passphraseOf(config);
    const opened = openArchive(envelope, passphrase);
    const header = opened.header;
    const { entries } = unpackContainer(opened.plain);

    const roots = this.roots(config);
    const rootById = new Map(roots.map((root) => [root.id, root]));
    const includeNodeModules = config.include?.nodeModules === true;
    /** @type {{ entry: any, target: string }[]} */
    const mapped = [];
    const unmapped = [];
    for (const entry of entries) {
      const parts = assertSafeArchivePath(entry.path);
      let [rootId, ...rel] = parts;
      let root = rootById.get(rootId);
      // 0.3 兼容：旧快照把 node_modules 放在 profile/ 前缀下，0.4 起是独立模块。
      // 本机开启了 nodeModules 时把这类条目映射到独立 root，恢复离线插件代码。
      if (rootId === 'profile' && rel[0] === 'node_modules' && rootById.has('node-modules')) {
        if (!includeNodeModules) {
          unmapped.push(entry.path);
          continue;
        }
        root = rootById.get('node-modules');
        rel = rel.slice(1);
      }
      if (!root || (root.type === 'files' && !(root.names ?? []).includes(rel.join('/')))) {
        unmapped.push(entry.path);
        continue;
      }
      const rootPath = root.path;
      const target = path.join(rootPath, ...rel.map(fromPosix));
      const relative = path.relative(rootPath, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`归档条目越界: ${entry.path}`);
      mapped.push({ entry, target });
    }

    const plan = [];
    const warnings = [];
    if (header.profile && header.profile !== name) {
      warnings.push(`这个快照来自配置「${header.profile}」，当前配置是「${name}」，请确认目标与口令是否对应。`);
    }
    for (const { entry, target } of mapped) {
      const local = await statOrNull(target);
      if (entry.type === 'dir') {
        if (!local) plan.push({ entry, target, action: 'mkdir' });
        continue;
      }
      if (entry.type === 'symlink') {
        const existing = local?.isSymbolicLink() ? await fs.readlink(target).catch(() => null) : null;
        if (existing === entry.link) continue;
        plan.push({ entry, target, action: existing === null ? 'add' : 'update', kind: 'symlink' });
        continue;
      }
      if (!local) {
        plan.push({ entry, target, action: 'add', size: entry.size });
        continue;
      }
      if (!local.isFile()) {
        plan.push({ entry, target, action: 'replace', size: entry.size });
        continue;
      }
      const data = await fs.readFile(target);
      if (sha256Hex(data) !== entry.sha256) plan.push({ entry, target, action: 'update', size: entry.size, localSize: local.size });
    }
    if (unmapped.length > 0) {
      // 0.3 快照的 node_modules 挂在 profile/ 前缀下，归名到独立模块而不是"DSH 配置档案"。
      const moduleNames = [
        ...new Set(unmapped.map((entryPath) => moduleLabelOfPrefix(entryPath.startsWith('profile/node_modules/') ? 'node-modules' : entryPath.split('/')[0]))),
      ];
      warnings.push(`快照里的以下内容不在本机当前的备份范围内（${moduleNames.join('、')}），已跳过 ${unmapped.length} 个条目。`);
    }

    // 预览阶段就计算插件安装计划，让用户在确认前看到恢复将触发的 pnpm 安装。
    const bundleInfo = await this.bundleDelta(entries);
    const summary = {
      dryRun,
      source,
      profile: name,
      snapshot: key,
      createdAt: header.createdAt,
      device: header.device,
      profileOfSnapshot: header.profile,
      sourcePlatform: header.platform,
      counts: header.counts,
      changes: plan.length,
      sample: plan.slice(0, 50).map((item) => ({ path: item.entry.path, action: item.action, size: item.size })),
      bundles: bundleInfo,
      warnings,
    };
    if (dryRun) return summary;

    const backupRoot = path.join(this.paths.backups, utcStamp());
    let written = 0;
    let backedUp = 0;
    for (const item of plan) {
      const { entry, target } = item;
      if (entry.type === 'dir') {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      const existing = await statOrNull(target);
      if (existing) {
        const backupPath = path.join(backupRoot, ...assertSafeArchivePath(entry.path));
        await fs.mkdir(path.dirname(backupPath), { recursive: true });
        await fs.copyFile(target, backupPath).catch(async () => {
          if (existing.isSymbolicLink()) await fs.writeFile(backupPath, await fs.readlink(target), 'utf8');
        });
        backedUp += 1;
      }
      if (entry.type === 'symlink') {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rm(target, { force: true });
        try {
          await fs.symlink(entry.link, target, 'file');
        } catch (error) {
          warnings.push(`无法创建符号链接 ${entry.path} -> ${entry.link}: ${error.message}`);
        }
        written += 1;
        continue;
      }
      const isCredentialFile = entry.path === 'credentials/.credentials.yaml' || entry.path === 'credentials/.env';
      const isSensitive = isCredentialFile || entry.path === 'mcp/mcp_connector.json';
      let data = entry.data;
      if (entry.path === 'credentials/.credentials.yaml' && existing) {
        const localText = await fs.readFile(target, 'utf8');
        const merged = mergeCredentialRecords(localText, entry.data.toString('utf8'));
        if (merged === null) continue;
        data = Buffer.from(merged, 'utf8');
        warnings.push('凭证已合并：保留了本机的设备绑定记录。');
      }
      if (entry.path === 'profile/package.json') {
        data = await this.mergePackageJson(data, warnings);
      }
      await writeFileAtomic(target, data, { mode: isSensitive ? 0o600 : entry.mode || 0o644 });
      if (ctx.verify !== false && entry.size <= 8 * 1024 * 1024) {
        const roundTrip = await fs.readFile(target);
        if (sha256Hex(roundTrip) !== sha256Hex(data)) warnings.push(`写入校验失败: ${entry.path}`);
      }
      written += 1;
    }

    const touchedProfile = plan.some((item) => item.entry.path.startsWith('profile/'));
    let installResult = null;
    if (bundleInfo.missing.length > 0 && config.restore?.installBundles !== false && ctx.installBundles !== false) {
      if (!this.installDependencies) {
        warnings.push(`需要安装 ${bundleInfo.missing.length} 个插件包，但当前环境无法调用包管理器；请重启 DSH 后在插件管理器中安装。`);
      } else {
        installResult = await this.installDependencies({ profileDir: this.profileDir });
        if (!installResult.ok) warnings.push(`插件依赖安装失败：${installResult.message}`);
      }
    }

    if (source === 'remote') {
      await this.saveState(
        putProfileState(state, name, {
          lastPull: { at: nowIso(), snapshot: key, files: written, contentHash: header.contentHash },
        }),
      );
    }
    await appendLog(this.paths.log, { op: 'pull', source, profile: name, key, files: written, backedUp });
    return {
      ...summary,
      source,
      dryRun: false,
      applied: true,
      written,
      backedUp,
      backupDir: backedUp > 0 ? backupRoot : null,
      bundles: bundleInfo,
      installResult,
      restartRequired: touchedProfile || installResult?.ok === true,
      warnings,
    };
  }

  /**
   * A snapshot's package.json carries the OTHER machine's plugin links. Keep this
   * machine's working `link:`/`file:` spec when the incoming path does not exist here,
   * so restoring a foreign snapshot cannot break the plugins already installed.
   * @param {Buffer} incomingData @param {string[]} warnings
   */
  async mergePackageJson(incomingData, warnings) {
    /** @type {any} */
    let incoming;
    try {
      incoming = JSON.parse(incomingData.toString('utf8'));
    } catch {
      return incomingData;
    }
    /** @type {any} */
    let current;
    try {
      current = JSON.parse(await fs.readFile(path.join(this.profileDir, 'package.json'), 'utf8'));
    } catch {
      return incomingData;
    }
    const currentDeps = current?.dependencies ?? {};
    if (Object.keys(currentDeps).length === 0) return incomingData;
    const merged = { ...incoming, dependencies: { ...(incoming.dependencies ?? {}) } };
    let changed = false;
    for (const [name, localSpec] of Object.entries(currentDeps)) {
      const incomingSpec = merged.dependencies[name];
      if (typeof incomingSpec !== 'string' || typeof localSpec !== 'string') continue;
      if (incomingSpec === localSpec) continue;
      if (!/^(link|file):/i.test(incomingSpec)) continue;
      const rawTarget = incomingSpec.replace(/^(link|file):/i, '');
      const target = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(this.profileDir, rawTarget);
      if (await pathExists(target)) continue;
      merged.dependencies[name] = localSpec;
      changed = true;
      warnings.push(`保留了本机的插件依赖 ${name}（快照里的路径 ${rawTarget} 在本机不存在）`);
    }
    if (!changed) return incomingData;
    return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  }

  /**
   * Compare the bundle list in a snapshot with the installed profile.
   * @param {any[]} entries
   */
  async bundleDelta(entries) {
    const file = entries.find((entry) => entry.path === 'profile/package.json');
    if (!file) return { missing: [], current: [], incoming: [] };
    /** @type {any} */
    let incoming = {};
    try {
      incoming = JSON.parse(file.data.toString('utf8'));
    } catch {
      return { missing: [], current: [], incoming: [] };
    }
    const incomingBundles = incoming?.dsh?.profile?.bundles ?? [];
    const dependencies = incoming?.dependencies ?? {};
    let current = {};
    try {
      current = JSON.parse(await fs.readFile(path.join(this.profileDir, 'package.json'), 'utf8'));
    } catch {
      current = {};
    }
    const currentBundles = new Set(current?.dsh?.profile?.bundles ?? []);
    const missing = incomingBundles.filter((bundle) => !currentBundles.has(bundle)).map((bundle) => ({ name: bundle, spec: dependencies[bundle] ?? 'latest' }));
    return { missing, current: [...currentBundles], incoming: incomingBundles };
  }

  /** Rename the local state entry that belongs to a renamed profile. */
  async renameState(from, to) {
    const state = await this.loadState();
    await this.saveState(renameProfileState(state, from, to));
  }

  /** Full status report; never throws on network failure. */
  async status() {
    const { doc, name, config } = await this.loadActive();
    const state = await this.loadState();
    const previous = profileState(state, name);
    let security = '未知';
    try {
      security = await this.store.describe();
    } catch {
      /* status must survive an unavailable secret backend */
    }
    const report = {
      profile: { name, names: doc.profiles.map((profile) => profile.name) },
      security,
      api: this.api ?? { registered: false, reason: '未初始化' },
      target: viewProfile(config).target,
      local: null,
      remote: null,
      schedule: config.schedule,
      problems: targetProblems(config),
      lastPush: previous.lastPush ?? null,
      lastPull: previous.lastPull ?? null,
      paths: { home: this.dshHome, profile: this.profileDir, data: this.paths.base },
    };
    try {
      const collected = await this.snapshot(config);
      report.local = {
        files: collected.stats.files,
        bytes: collected.stats.bytes,
        bytesText: formatBytes(collected.stats.bytes),
        contentHash: collected.stats.contentHash,
        changedSinceLastPush: previous.lastPush ? previous.lastPush.contentHash !== collected.stats.contentHash : true,
        warnings: collected.warnings,
        roots: collected.stats.roots,
      };
    } catch (error) {
      report.local = { error: error.message };
    }
    if (report.problems.length === 0) {
      try {
        const backend = this.backend(config);
        const latest = await this.readLatest(backend);
        report.remote = latest
          ? {
              target: backend.label,
              latest: {
                snapshot: latest.snapshot,
                createdAt: latest.createdAt,
                device: latest.device,
                profile: latest.profile,
                files: latest.files,
                bytesText: formatBytes(latest.bytes ?? 0),
              },
              upToDate: latest.contentHash === report.local?.contentHash,
            }
          : { target: backend.label, latest: null };
      } catch (error) {
        report.remote = { error: error.message };
      }
    }
    return report;
  }
}

/** Backends return either "snapshots/x" or "x" depending on their list semantics. */
function snapshotName(key) {
  const value = String(key ?? '');
  return value.startsWith(`${SNAPSHOT_DIR}/`) ? value.slice(SNAPSHOT_DIR.length + 1) : value;
}

/** Hostnames may contain characters that filesystems dislike; keep them readable. */
function sanitizeDevice(name) {
  const slug = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return slug || 'device';
}

/**
 * Parse `<device>_<utc stamp>_<rand>.dshsync`. Names written before 0.3.5
 * (`<stamp>-<rand>.dshsync`) simply return null and fall back to file mtime.
 * @param {string} name
 * @returns {{ device: string, at: string, stamp: string } | null}
 */
function parseSnapshotName(name) {
  const match = String(name).match(/^(.*)_(\d{8}T\d{6}Z)_([0-9a-f]+)\.dshsync$/);
  if (!match) return null;
  const stamp = match[2];
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  return { device: match[1], at: iso, stamp };
}

/** @param {{ key: string, lastModified?: string }} item */
function snapshotTime(item) {
  const parsed = parseSnapshotName(snapshotName(item.key));
  return parsed ? parsed.at : String(item.lastModified ?? '');
}

/** @param {string | undefined} iso */
function formatLocal(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

/**
 * Resolve a user-supplied path to exactly one snapshot file.
 * @param {string} inputPath
 * @returns {Promise<string>}
 */
async function resolveSnapshotFile(inputPath) {
  const raw = String(inputPath ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new Error('请填写 .dshsync 快照文件，或包含快照的目录');
  const abs = path.resolve(raw.replace(/^~(?=$|[/\\])/, os.homedir()));
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`路径不存在：${abs}`);
  }
  if (stat.isFile()) {
    if (!abs.toLowerCase().endsWith('.dshsync')) throw new Error('请选择 .dshsync 快照文件');
    return abs;
  }
  if (!stat.isDirectory()) throw new Error(`不支持的路径类型：${abs}`);
  /** @type {string[]} */
  const candidates = [];
  for (const dir of [abs, path.join(abs, 'snapshots'), path.join(abs, 'dsh-sync', 'snapshots'), path.join(abs, 'dsh-sync')]) {
    /** @type {import('node:fs').Dirent[]} */
    let items = [];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (item.isFile() && item.name.toLowerCase().endsWith('.dshsync')) candidates.push(path.join(dir, item.name));
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) throw new Error(`这个目录里没有 .dshsync 快照：${abs}`);
  if (candidates.length > 1) {
    const names = candidates.slice(0, 6).map((item) => path.basename(item)).join('、');
    throw new Error(`目录里有 ${candidates.length} 个快照，请直接选择其中一个文件：${names}`);
  }
  return candidates[0];
}

/** @param {string} target */
async function statOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}
