/**
 * At-rest encryption for the local config file.
 *
 * Backends, in order of preference:
 *  - `sm1`: Electron `safeStorage` (Windows DPAPI / macOS Keychain, bound to the OS user).
 *  - `ev1`: AES-256-GCM with a key derived from DSH_SYNC_MASTER_KEY (servers, advanced users).
 *  - `ag1`: AES-256-GCM with a random key file next to the config (obfuscation only; last resort).
 *
 * The whole document is encrypted, so a copied config.json reveals nothing but its size.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './util.js';

const ENV_SALT = 'dsh-sync-config-v1';

/** @param {Buffer} key @param {string} plaintext */
function encryptGcm(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** @param {Buffer} key @param {Buffer} packed */
function decryptGcm(key, packed) {
  if (packed.length < 29) throw new Error('加密配置已损坏');
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export class SecretStore {
  /**
   * @param {{ dir: string, envKeyName?: string }} options
   */
  constructor(options) {
    this.dir = options.dir;
    this.envKeyName = options.envKeyName ?? 'DSH_SYNC_MASTER_KEY';
    this.backend = undefined;
    this.keyPath = path.join(this.dir, 'secret.key');
    /** @type {any} */
    this.safeStorage = undefined;
    /** @type {Buffer | undefined} */
    this.envKey = undefined;
  }

  /** @returns {Promise<'sm1'|'ev1'|'ag1'>} */
  async init() {
    if (this.backend) return this.backend;
    const failures = [];
    // In Electron main, `require('electron')` is the reliable path; a dynamic ESM
    // import can resolve to an empty namespace under a custom loader.
    for (const load of [
      async () => {
        const { createRequire } = await import('node:module');
        return createRequire(import.meta.url)('electron');
      },
      async () => await import('electron'),
    ]) {
      try {
        const electron = await load();
        const safeStorage = electron?.safeStorage ?? electron?.default?.safeStorage;
        if (safeStorage?.isEncryptionAvailable?.()) {
          this.safeStorage = safeStorage;
          this.backend = 'sm1';
          return this.backend;
        }
        failures.push(safeStorage ? 'safeStorage 报告系统加密不可用' : 'electron 模块里没有 safeStorage');
      } catch (error) {
        failures.push(String(error?.message ?? error).split('\n')[0]);
      }
    }
    this.detail = failures.join('；');
    const fromEnv = process.env[this.envKeyName];
    if (typeof fromEnv === 'string' && fromEnv.length >= 16) {
      this.envKey = scryptSync(fromEnv, ENV_SALT, 32);
      this.backend = 'ev1';
      return this.backend;
    }
    this.backend = 'ag1';
    return this.backend;
  }

  /** Human-readable description for status output. */
  async describe() {
    const backend = await this.init();
    const base = {
      sm1: '系统密钥保护（Windows DPAPI / macOS 钥匙串）',
      ev1: `环境变量 ${this.envKeyName} 派生的密钥（AES-256-GCM）`,
      ag1: '本地密钥文件（AES-256-GCM，仅防误读，不能防同机读取）',
    }[backend];
    return this.detail ? `${base}；系统密钥不可用原因：${this.detail}` : base;
  }

  async #keyFile(create) {
    try {
      return await fs.readFile(this.keyPath);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
      if (!create) throw new Error(`找不到本地密钥文件 ${this.keyPath}，无法解密已保存的配置`);
      const key = randomBytes(32);
      await writeFileAtomic(this.keyPath, key, { mode: 0o600 });
      return key;
    }
  }

  /**
   * @param {unknown} value
   * @returns {Promise<{ cipher: string, blob: string }>}
   */
  async seal(value) {
    const backend = await this.init();
    const json = JSON.stringify(value);
    if (backend === 'sm1') {
      return { cipher: 'sm1', blob: this.safeStorage.encryptString(json).toString('base64') };
    }
    const key = backend === 'ev1' ? this.envKey : await this.#keyFile(true);
    if (!key) throw new Error('配置加密密钥不可用');
    return { cipher: backend, blob: encryptGcm(key, json) };
  }

  /**
   * @param {{ cipher?: string, blob?: string }} payload
   * @returns {Promise<any>}
   */
  async open(payload) {
    const backend = await this.init();
    const cipher = payload?.cipher;
    if (!cipher || !payload?.blob) throw new Error('配置文件缺少密文');
    const packed = Buffer.from(payload.blob, 'base64');
    if (cipher === 'sm1') {
      if (!this.safeStorage) {
        throw new Error('这份配置由系统密钥保护，但当前进程无法访问系统密钥（换机器或换了系统用户？）。请重新填写同步配置。');
      }
      return JSON.parse(this.safeStorage.decryptString(packed));
    }
    if (cipher === 'ev1') {
      const key = this.envKey ?? (process.env[this.envKeyName] ? scryptSync(process.env[this.envKeyName], ENV_SALT, 32) : undefined);
      if (!key) throw new Error(`这份配置由环境变量 ${this.envKeyName} 派生密钥加密，请先设置该变量`);
      return JSON.parse(decryptGcm(key, packed));
    }
    if (cipher === 'ag1') {
      const key = await this.#keyFile(false);
      return JSON.parse(decryptGcm(key, packed));
    }
    if (backend === 'sm1' && typeof cipher === 'string') throw new Error(`未知的配置加密格式: ${cipher}`);
    throw new Error(`未知的配置加密格式: ${String(cipher)}`);
  }
}
