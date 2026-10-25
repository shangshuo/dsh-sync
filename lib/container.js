/**
 * Container format + authenticated encryption for DSH Sync archives.
 *
 * Plain archive (before encryption):
 *   "DSHSYNC2\n" | uint32 BE headerLength | header JSON | concatenated entry payloads
 *
 * Encrypted envelope (the only thing ever written to remote storage):
 *   "DSHSYNC2-ENC\n" | one-line JSON envelope header | ciphertext | 32-byte HMAC-SHA256
 *
 * Cipher: AES-256-CTR, keys derived with scrypt (N=32768, r=8, p=1) from the user passphrase.
 * MAC: HMAC-SHA256 over the ciphertext (encrypt-then-MAC), verified before any decryption.
 * Node's `crypto` is the only dependency, so the archive can be decoded from any Node 20+ host.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

import { sha256Hex } from './util.js';

const MAGIC = Buffer.from('DSHSYNC2\n', 'utf8');
const ENC_PREFIX = Buffer.from('DSHSYNC2-ENC\n', 'utf8');
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 64, maxmem: 128 * 1024 * 1024 };
const FORMAT = 'dsh-sync/2';

/**
 * @typedef {object} ArchiveEntry
 * @property {string} path virtual path, e.g. "profile/cordis.patch.yml"
 * @property {'file'|'dir'|'symlink'} type
 * @property {number} mode
 * @property {number} size
 * @property {string} sha256
 * @property {Buffer} [data]
 * @property {string} [link]
 */

/**
 * Pack entries into the plain archive format.
 * @param {object} header archive metadata (JSON-serializable)
 * @param {ArchiveEntry[]} entries
 * @returns {Buffer}
 */
export function packContainer(header, entries) {
  const meta = entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    sha256: entry.sha256,
    ...(entry.link === undefined ? {} : { link: entry.link }),
  }));
  const headerJson = Buffer.from(JSON.stringify({ format: FORMAT, ...header, entries: meta }), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerJson.length, 0);
  const parts = [MAGIC, length, headerJson];
  for (const entry of entries) {
    if (entry.type === 'file') {
      const data = entry.data;
      if (!Buffer.isBuffer(data)) throw new Error(`entry ${entry.path} has no content`);
      if (data.length !== entry.size) throw new Error(`entry ${entry.path} size mismatch`);
      parts.push(data);
    } else if (entry.type === 'symlink') {
      parts.push(Buffer.from(entry.link ?? '', 'utf8'));
    }
  }
  return Buffer.concat(parts);
}

/**
 * Unpack a plain archive.
 * @param {Buffer} buffer
 * @returns {{ header: any, entries: ArchiveEntry[] }}
 */
export function unpackContainer(buffer) {
  if (buffer.length < MAGIC.length + 4) throw new Error('不是有效的 DSH Sync 归档（文件太小）');
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是有效的 DSH Sync 归档（魔数不匹配）');
  }
  const headerLength = buffer.readUInt32BE(MAGIC.length);
  if (headerLength <= 0 || headerLength > buffer.length - MAGIC.length - 4) {
    throw new Error('DSH Sync 归档头损坏');
  }
  const headerStart = MAGIC.length + 4;
  const headerText = buffer.subarray(headerStart, headerStart + headerLength).toString('utf8');
  /** @type {any} */
  let header;
  try {
    header = JSON.parse(headerText);
  } catch (error) {
    throw new Error(`DSH Sync 归档头不是合法 JSON: ${error.message}`);
  }
  if (header?.format !== FORMAT) throw new Error(`不支持的归档版本: ${String(header?.format)}`);
  if (!Array.isArray(header.entries)) throw new Error('DSH Sync 归档缺少条目表');
  let offset = headerStart + headerLength;
  /** @type {ArchiveEntry[]} */
  const entries = [];
  for (const raw of header.entries) {
    const type = raw.type;
    if (type === 'file') {
      const size = Number(raw.size);
      if (!Number.isInteger(size) || size < 0 || offset + size > buffer.length) {
        throw new Error(`条目 ${raw.path} 的数据被截断`);
      }
      const data = buffer.subarray(offset, offset + size);
      offset += size;
      const actual = sha256Hex(data);
      if (raw.sha256 && actual !== raw.sha256) throw new Error(`条目 ${raw.path} 校验失败`);
      entries.push({ path: raw.path, type, mode: raw.mode ?? 0o644, size, sha256: actual, data: Buffer.from(data) });
    } else if (type === 'symlink') {
      const link = String(raw.link ?? '');
      // Writers before 0.3.6 appended the link bytes but recorded size 0; skipping them
      // here keeps every following file at its real offset (and also accepts archives
      // that do record the payload size).
      const payload = Number(raw.size) > 0 ? Number(raw.size) : Buffer.byteLength(link, 'utf8');
      if (offset + payload > buffer.length) throw new Error(`条目 ${raw.path} 的数据被截断`);
      offset += payload;
      entries.push({ path: raw.path, type, mode: raw.mode ?? 0o777, size: 0, sha256: raw.sha256 ?? '', link });
    } else if (type === 'dir') {
      entries.push({ path: raw.path, type, mode: raw.mode ?? 0o755, size: 0, sha256: '' });
    } else {
      throw new Error(`未知条目类型: ${String(type)} (${raw.path})`);
    }
  }
  return { header, entries };
}

/**
 * Compress and encrypt a plain archive.
 * @param {Buffer} plain
 * @param {string} passphrase
 * @param {{ createdAt?: string, label?: string }} [options]
 * @returns {Buffer}
 */
export function sealArchive(plain, passphrase, options = {}) {
  requirePassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem });
  const encKey = key.subarray(0, 32);
  const macKey = key.subarray(32, 64);
  const compressed = gzipSync(plain, { level: 6 });
  const cipher = createCipheriv('aes-256-ctr', encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(ciphertext).digest();
  const header = {
    format: FORMAT,
    envelope: 1,
    cipher: 'aes-256-ctr',
    mac: 'hmac-sha256',
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    plainBytes: compressed.length,
    createdAt: options.createdAt ?? new Date().toISOString(),
    label: options.label ?? '',
  };
  return Buffer.concat([ENC_PREFIX, Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ciphertext, mac]);
}

/**
 * Verify and decrypt an envelope, returning the plain archive.
 * @param {Buffer} envelope
 * @param {string} passphrase
 * @returns {{ plain: Buffer, header: any }}
 */
export function openArchive(envelope, passphrase) {
  requirePassphrase(passphrase);
  if (envelope.length < ENC_PREFIX.length + 64) throw new Error('DSH Sync 归档损坏（文件太小）');
  if (!envelope.subarray(0, ENC_PREFIX.length).equals(ENC_PREFIX)) {
    throw new Error('不是 DSH Sync 加密归档（可能是旧版本或被截断）');
  }
  const rest = envelope.subarray(ENC_PREFIX.length);
  const newline = rest.indexOf(0x0a);
  if (newline < 0) throw new Error('DSH Sync 归档头损坏');
  /** @type {any} */
  let header;
  try {
    header = JSON.parse(rest.subarray(0, newline).toString('utf8'));
  } catch (error) {
    throw new Error(`DSH Sync 归档头不是合法 JSON: ${error.message}`);
  }
  if (header?.format !== FORMAT || header?.cipher !== 'aes-256-ctr') {
    throw new Error(`不支持的归档加密格式: ${String(header?.cipher)}`);
  }
  const ciphertext = rest.subarray(newline + 1, rest.length - 32);
  const mac = rest.subarray(rest.length - 32);
  const salt = Buffer.from(header.kdf.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  const key = scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLen, {
    N: header.kdf.N,
    r: header.kdf.r,
    p: header.kdf.p,
    maxmem: KDF.maxmem,
  });
  const expected = createHmac('sha256', key.subarray(32, 64)).update(ciphertext).digest();
  if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) {
    throw new Error('口令错误，或归档已被篡改（HMAC 校验失败）');
  }
  const decipher = createDecipheriv('aes-256-ctr', key.subarray(0, 32), iv);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  let plain;
  try {
    plain = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`归档解压失败: ${error.message}`);
  }
  return { plain, header };
}

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('同步口令未配置或太短（至少 8 个字符）。口令用于加密云端归档，请用 sync_configure 设置。');
  }
}
