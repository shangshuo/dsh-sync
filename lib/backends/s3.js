/** S3-compatible object storage backend with hand-rolled AWS Signature V4. */
import { createHash, createHmac } from 'node:crypto';

import { t } from '../i18n.js';
import { httpRequest, withRetry } from '../http.js';
import { EMPTY_SHA256, formatBytes, sha256Hex } from '../util.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

/** RFC 3986 encoding that AWS expects (encodeURIComponent leaves !'()* alone). */
export function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Encode a URL pathname segment-by-segment, preserving slashes. */
export function canonicalUri(pathname) {
  if (!pathname) return '/';
  return pathname
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* keep the raw segment when it is not valid percent-encoding */
      }
      return encodeRfc3986(decoded);
    })
    .join('/');
}

/** AWS canonical query string: sorted by name then value, strictly encoded. */
export function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) pairs.push([key, value]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function amzDateStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Sign one request. `headers` are the headers to sign; `host` is derived from the URL.
 * @param {{ method: string, url: string | URL, headers?: Record<string, string>, payloadHash: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string, region: string, service?: string, date?: Date }} input
 * @returns {{ authorization: string, amzDate: string }}
 */
export function signV4(input) {
  const url = typeof input.url === 'string' ? new URL(input.url) : input.url;
  const date = input.date ?? new Date();
  const amzDate = amzDateStamp(date);
  const dateStamp = amzDate.slice(0, 8);
  const service = input.service ?? SERVICE;
  const signed = { ...(input.headers ?? {}) };
  signed.host = signed.host ?? url.host;
  signed['x-amz-date'] = amzDate;
  signed['x-amz-content-sha256'] = input.payloadHash;
  if (input.sessionToken) signed['x-amz-security-token'] = input.sessionToken;

  const normalized = Object.entries(signed).map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]);
  normalized.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = normalized.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = normalized.map(([key]) => key).join(';');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
  };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlFirst(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1]) : undefined;
}

function xmlBlocks(xml, tag) {
  const blocks = [];
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) blocks.push(match[1]);
  return blocks;
}

function s3Error(text, status) {
  const code = xmlFirst(text, 'Code') ?? `HTTP ${status}`;
  const message = xmlFirst(text, 'Message') ?? '';
  const error = new Error(t('S3 请求失败: {code} - {message}（HTTP {status}）', { code, message, status }));
  error.code = code;
  error.status = status;
  return error;
}

/** One S3-compatible bucket + prefix. */
export class S3Backend {
  /** @param {any} s3Config @param {string} prefix */
  constructor(s3Config, prefix) {
    this.kind = 's3';
    this.prefix = prefix;
    this.config = s3Config;
    this.bucket = s3Config.bucket;
    this.region = s3Config.region || 'us-east-1';
    if (!s3Config.endpoint && this.region === 'auto') {
      throw new Error(t('S3 配置缺少 endpoint（Cloudflare R2 / MinIO / Backblaze 等必须填写 endpoint）'));
    }
    this.endpoint = (s3Config.endpoint || `https://s3.${this.region}.amazonaws.com`).replace(/\/+$/, '');
    this.pathStyle = s3Config.pathStyle !== false;
  }

  get label() {
    return `S3 ${this.bucket} @ ${this.endpoint}`;
  }

  /** @param {string} key @param {Record<string,string>} [query] */
  urlFor(key, query) {
    return this.urlForFullKey(this.fullKey(key), query);
  }

  /** Prefix every object key so one bucket can host several installations. */
  fullKey(key) {
    const trimmed = String(key ?? '').replace(/^\/+/, '');
    if (!this.prefix) return trimmed;
    return trimmed ? `${this.prefix}/${trimmed}` : this.prefix;
  }

  /** @param {string} fullKey @param {Record<string,string>} [query] */
  urlForFullKey(fullKey, query) {
    const base = new URL(this.endpoint);
    const encodedKey = fullKey === '' ? '' : canonicalUri(`/${fullKey}`);
    if (this.pathStyle) {
      base.pathname = `/${this.bucket}${encodedKey}`;
    } else {
      base.host = `${this.bucket}.${base.host}`;
      base.pathname = encodedKey === '' ? '/' : encodedKey;
    }
    if (query) {
      for (const [name, value] of Object.entries(query)) base.searchParams.set(name, value);
    }
    return base;
  }

  /** @param {{ method: string, key: string, query?: Record<string,string>, body?: Buffer, contentType?: string, bucketOnly?: boolean }} request */
  async send(request) {
    const url = request.bucketOnly ? this.urlForFullKey('', request.query) : this.urlFor(request.key, request.query);
    const body = request.body;
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    /** @type {Record<string,string>} */
    const headers = {};
    if (request.contentType) headers['content-type'] = request.contentType;
    const { authorization, amzDate } = signV4({
      method: request.method,
      url,
      headers,
      payloadHash,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken || undefined,
      region: this.region,
    });
    const outgoing = {
      ...headers,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization,
      ...(this.config.sessionToken ? { 'x-amz-security-token': this.config.sessionToken } : {}),
    };
    return httpRequest(url, { method: request.method, headers: outgoing, body, timeoutMs: 120_000 });
  }

  /** @param {string} key @param {Buffer} bytes @param {string} [contentType] */
  async put(key, bytes, contentType = 'application/octet-stream') {
    const response = await withRetry(async () => {
      const result = await this.send({ method: 'PUT', key, body: bytes, contentType });
      if (!result.ok) throw s3Error(result.text, result.status);
      return result;
    });
    return { etag: response.headers.get('etag') ?? undefined, bytes: bytes.length };
  }

  /** @param {string} key @returns {Promise<Buffer | null>} */
  async get(key) {
    const result = await this.send({ method: 'GET', key });
    if (result.status === 404) return null;
    if (!result.ok) throw s3Error(result.text, result.status);
    return result.body;
  }

  /** @param {string} key @returns {Promise<{ size: number, etag?: string, lastModified?: string } | null>} */
  async head(key) {
    const result = await this.send({ method: 'HEAD', key });
    if (result.status === 404) return null;
    if (!result.ok) throw s3Error(result.text, result.status);
    const length = Number(result.headers.get('content-length') ?? 0);
    return {
      size: Number.isFinite(length) ? length : 0,
      etag: result.headers.get('etag') ?? undefined,
      lastModified: result.headers.get('last-modified') ?? undefined,
    };
  }

  /** @param {string} prefix @returns {Promise<{ key: string, size: number, lastModified?: string }[]>} */
  async list(prefix) {
    /** @type {{ key: string, size: number, lastModified?: string }[]} */
    const out = [];
    let token;
    for (let page = 0; page < 20; page += 1) {
      const query = { 'list-type': '2', prefix: this.fullKey(prefix), 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const result = await this.send({ method: 'GET', key: '', query, bucketOnly: true });
      if (!result.ok) throw s3Error(result.text, result.status);
      const xml = result.text;
      for (const block of xmlBlocks(xml, 'Contents')) {
        const key = xmlFirst(block, 'Key');
        if (!key) continue;
        const relative = this.prefix && key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
        out.push({
          key: relative,
          size: Number(xmlFirst(block, 'Size') ?? 0),
          lastModified: xmlFirst(block, 'LastModified'),
        });
      }
      if (xmlFirst(xml, 'IsTruncated') !== 'true') break;
      token = xmlFirst(xml, 'NextContinuationToken');
      if (!token) break;
    }
    return out;
  }

  /** @param {string} key */
  async delete(key) {
    const result = await this.send({ method: 'DELETE', key });
    if (!result.ok && result.status !== 404) throw s3Error(result.text, result.status);
  }

  async test() {
    try {
      const listed = await this.list('');
      const probeKey = '.dsh-sync-probe';
      await this.put(probeKey, Buffer.from(`probe ${new Date().toISOString()}`), 'text/plain');
      const head = await this.head(probeKey);
      await this.delete(probeKey);
      return {
        ok: true,
        message: t('已连接 {label}，前缀 {prefix}/ 下现有 {n} 个对象，读写正常（探测对象 {size}）。', { label: this.label, prefix: this.prefix, n: listed.length, size: formatBytes(head?.size ?? 0) }),
      };
    } catch (error) {
      return { ok: false, message: t('连接 {label} 失败: {message}', { label: this.label, message: error.message }) };
    }
  }
}

/** Exported for tests: hash of an empty body. */
export const EMPTY_BODY_SHA256 = EMPTY_SHA256;

/** Exported for tests: HMAC-SHA256 helper. */
export const _hmac = createHmac;
