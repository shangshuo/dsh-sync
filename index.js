/**
 * DSH Sync — encrypted, scheduled backup/restore of a DSH profile.
 *
 * Every registration goes through `ctx.effect`, so unloading the plugin (or a profile
 * hot-reload) removes the tools and the scheduler.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setLang } from './lib/i18n.js';
import { appendLog, profileState, putProfileState, syncPaths, targetProblems } from './lib/config.js';
import { t } from './lib/i18n.js';
import { mountApi } from './lib/api.js';
import { SyncEngine } from './lib/engine.js';
import { registerTools } from './lib/tools.js';

/** The tools registry is the only hard dependency; every Harness profile with agents has it. */
export const inject = ['tools'];

/**
 * Resolve the DSH home and the active profile directory. Environment variables are set by
 * the desktop launcher; the fallbacks keep the plugin usable in a plain `dsh` process.
 * @returns {{ dshHome: string, profileName: string, profileDir: string }}
 */
function resolvePaths() {
  const dshHome = (process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  let profileName = (process.env.DSH_PROFILE ?? '').trim();
  let profileDir = (process.env.DSH_PROFILE_DIR ?? '').trim();
  if (!profileDir) {
    const root = path.join(dshHome, 'profiles');
    /** @type {string[]} */
    let names = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
    if (!profileName) profileName = names.includes('desktop') ? 'desktop' : (names[0] ?? 'desktop');
    profileDir = path.join(root, profileName);
  }
  if (!profileName) profileName = path.basename(profileDir) || 'desktop';
  return { dshHome, profileName, profileDir };
}

/**
 * Reinstall the profile's dependencies with the package manager DSH itself uses.
 * `profileContext.packageManager` carries the bundled pnpm invocation in the desktop app.
 * @param {any} ctx
 * @param {{ profileDir: string }} input
 */
async function installDependencies(ctx, { profileDir }) {
  const manager = ctx.get('profileContext')?.packageManager;
  let command = manager?.command ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  let args = [...(manager?.args ?? []), 'install', '--prefer-offline', '--no-frozen-lockfile'];
  // A .cmd shim cannot be spawned directly on Windows; route it through cmd.exe.
  if (!manager && process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    args = ['/d', '/s', '/c', command, ...args];
    command = 'cmd.exe';
  }
  const env = { ...process.env, ...(manager?.env ?? {}) };
  return await new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { cwd: profileDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, message: t('无法启动包管理器 {command}: {message}', { command, message: error.message }) });
      return;
    }
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-8000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: t('插件依赖安装超时（10 分钟）。') });
    }, 10 * 60 * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: t('无法启动包管理器 {command}: {message}', { command, message: error.message }) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = output.trim().split('\n').slice(-8).join('\n');
      resolve({
        ok: code === 0,
        message: code === 0 ? t('依赖安装完成（{command} install）。', { command: path.basename(command) }) : t('包管理器退出码 {code}。{tail}', { code, tail: tail ? `\n${tail}` : '' }),
      });
    });
  });
}

/**
 * Run a push every `schedule.intervalMinutes` when it is due. A one-minute tick keeps the
 * interval editable from the config file without re-registering timers.
 * @param {any} ctx
 * @param {SyncEngine} engine
 */
function startScheduler(ctx, engine) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    try {
      const { config, name } = await engine.loadActive();
      if (config.schedule?.enabled !== true) return;
      const intervalMinutes = Math.max(5, Number(config.schedule.intervalMinutes ?? 30));
      const state = await engine.loadState();
      const previous = profileState(state, name);
      const last = Date.parse(previous.lastAttemptAt ?? previous.lastPush?.at ?? 0) || 0;
      if (Date.now() - last < intervalMinutes * 60_000) return;
      if (targetProblems(config).length > 0) return;
      running = true;
      await engine.saveState(putProfileState(state, name, { lastAttemptAt: new Date().toISOString() }));
      const result = await engine.push({ reason: 'schedule' });
      await appendLog(engine.paths.log, { op: 'schedule', profile: name, skipped: result.skipped === true, key: result.key });
    } catch (error) {
      await appendLog(engine.paths.log, { op: 'schedule', error: String(error?.message ?? error) });
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), 60_000);
  const initial = setTimeout(() => void tick(), 120_000);
  if (typeof interval.unref === 'function') interval.unref();
  if (typeof initial.unref === 'function') initial.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(initial);
  };
}

/**
 * @param {any} ctx Cordis context of the `dsh-sync` plugin row.
 */
export function apply(ctx) {
  // 跟随 DSH 的语言设置：locale 服务是可选依赖（旧版本没有），存在时读取当前
  // locale 并订阅切换；agent 工具与所有 Host 侧消息随之双语。设置页另经
  // 请求头逐请求覆盖（api.js），两者不冲突。
  if (typeof ctx.get === 'function') {
    try {
      const localeService = ctx.get('locale');
      if (localeService?.getSnapshot) {
        const applyLocale = () => {
          try {
            const id = String(localeService.getSnapshot()?.active ?? '');
            setLang(id.toLowerCase().startsWith('zh') ? 'zh' : 'en');
          } catch {
            /* locale 快照异常不阻塞插件 */
          }
        };
        applyLocale();
        if (typeof localeService.subscribe === 'function') {
          ctx.effect(() => localeService.subscribe(applyLocale));
        }
      }
    } catch {
      /* 无 locale 服务时保持默认中文 */
    }
  }
  const resolved = resolvePaths();
  const engine = new SyncEngine({
    dshHome: resolved.dshHome,
    profileDir: resolved.profileDir,
    profileName: resolved.profileName,
    installDependencies: (input) => installDependencies(ctx, input),
  });
  const paths = syncPaths(resolved.dshHome);
  registerTools(ctx, { engine });
  mountApi(ctx, engine);
  ctx.effect(() => startScheduler(ctx, engine));
  void appendLog(paths.log, { op: 'activate', dshHome: resolved.dshHome, profile: resolved.profileName, platform: process.platform });
}
