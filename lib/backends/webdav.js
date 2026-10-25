/** WebDAV backend: works with Nextcloud, ownCloud, 坚果云, Synology, Yandex Disk, rclone serve webdav, ... */
import { t } from '../i18n.js';
import { httpRequest, withRetry } from '../http.js';

const XML_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;

function xmlFirst(xml, localName) {
  const match = xml.match(new RegExp(`<(?:[A-Za-z0-9._-]+:)?${localName}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>`));
  return match ? match[1] : undefined;
}

function xmlBlocks(xml, localName) {
  const blocks = [];
  const regex = new RegExp(`<(?:[A-Za-z0-9._-]+:)?${localName}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) blocks.push(match[1]);
  return blocks;
}

function decodeXmlText(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encodeSegments(segments) {
  return segments
    .filter((segment) => segment !== '' && segment !== undefined && segment !== null)
    .map((segment) => encodeURIComponent(String(segment)))
    .join('/');
}

/** One WebDAV collection + base path. */
export class WebDavBackend {
  /** @param {any} webdavConfig @param {string} prefix */
  constructor(webdavConfig, prefix) {
    this.kind = 'webdav';
    this.prefix = prefix;
    this.config = webdavConfig;
    if (!webdavConfig?.url) throw new Error(t('WebDAV 配置缺少 url'));
    this.base = new URL(webdavConfig.url);
    if (!this.base.pathname.endsWith('/')) this.base.pathname = `${this.base.pathname}/`;
    this.baseSegments = this.base.pathname.split('/').filter(Boolean);
    this.extraSegments = String(webdavConfig.basePath ?? '')
      .split('/')
      .filter(Boolean);
    this.username = webdavConfig.username ?? '';
    this.password = webdavConfig.password ?? '';
  }

  get label() {
    return `WebDAV ${this.base.origin}${this.base.pathname}`;
  }

  authHeaders() {
    if (!this.username && !this.password) return {};
    const token = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64');
    return { authorization: `Basic ${token}` };
  }

  /** @param {string[]} segments */
  urlFor(segments) {
    const joined = [...this.baseSegments, ...this.extraSegments, ...segments].map((segment) => String(segment));
    const url = new URL(this.base.href);
    const encoded = encodeSegments(joined);
    url.pathname = `/${encoded}`;
    url.search = '';
    return url;
  }

  /** Path segments of the sync prefix. */
  prefixSegments() {
    return this.prefix ? this.prefix.split('/').filter(Boolean) : [];
  }

  /** @param {string} key */
  keySegments(key) {
    return [...this.prefixSegments(), ...String(key).replace(/^\/+/, '').split('/').filter(Boolean)];
  }

  async ensureCollection(segments) {
    for (let index = 0; index <= segments.length; index += 1) {
      const partial = segments.slice(0, index);
      if (partial.length === 0) continue;
      const url = this.urlFor(partial);
      const response = await httpRequest(url, { method: 'MKCOL', headers: this.authHeaders(), timeoutMs: 30_000 });
      if (response.status === 405 || response.status === 301 || response.status === 200 || response.status === 201) continue;
      if (response.status === 409) continue;
      if (!response.ok) {
        throw new Error(t('WebDAV 创建目录失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
      }
    }
  }

  /** @param {string} key @param {Buffer} bytes @param {string} [contentType] */
  async put(key, bytes, contentType = 'application/octet-stream') {
    const segments = this.keySegments(key);
    const url = this.urlFor(segments);
    const attempt = async () => {
      const response = await httpRequest(url, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'content-type': contentType },
        body: bytes,
        timeoutMs: 180_000,
      });
      if (response.status === 409) {
        await this.ensureCollection(segments.slice(0, -1));
        return null;
      }
      if (!response.ok) throw new Error(t('WebDAV 上传失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
      return response;
    };
    await withRetry(async () => {
      const result = await attempt();
      if (result === null) {
        const retry = await attempt();
        if (retry === null) throw new Error(t('WebDAV 上传失败：父目录不可用 {path}', { path: url.pathname }));
      }
      return true;
    });
    return { bytes: bytes.length };
  }

  /** @param {string} key @returns {Promise<Buffer | null>} */
  async get(key) {
    const url = this.urlFor(this.keySegments(key));
    const response = await httpRequest(url, { method: 'GET', headers: this.authHeaders(), timeoutMs: 180_000 });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(t('WebDAV 下载失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
    return response.body;
  }

  /** @param {string} key @returns {Promise<{ size: number, lastModified?: string } | null>} */
  async head(key) {
    const url = this.urlFor(this.keySegments(key));
    const response = await httpRequest(url, { method: 'HEAD', headers: this.authHeaders(), timeoutMs: 30_000 });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(t('WebDAV HEAD 失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
    return {
      size: Number(response.headers.get('content-length') ?? 0),
      lastModified: response.headers.get('last-modified') ?? undefined,
    };
  }

  /** @param {string} key @returns {Promise<{ key: string, size: number, lastModified?: string }[]>} */
  async list(key) {
    const prefixSegments = [...this.prefixSegments(), ...String(key).replace(/^\/+/, '').split('/').filter(Boolean)];
    const url = this.urlFor(prefixSegments);
    const response = await httpRequest(url, {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: XML_PROPFIND,
      timeoutMs: 60_000,
    });
    if (response.status === 404) return [];
    if (!response.ok && response.status !== 207) {
      throw new Error(t('WebDAV 列目录失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
    }
    const basePath = `/${encodeSegments([...this.baseSegments, ...this.extraSegments, ...prefixSegments])}`;
    const results = [];
    for (const block of xmlBlocks(response.text, 'response')) {
      const rawHref = xmlFirst(block, 'href');
      if (!rawHref) continue;
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(decodeXmlText(rawHref), url).pathname);
      } catch {
        continue;
      }
      const isCollection = /<[^>]*collection\s*\/?>/i.test(block);
      if (isCollection) continue;
      const normalizedBase = decodeURIComponent(basePath).replace(/\/+$/, '');
      if (!pathname.startsWith(`${normalizedBase}/`)) continue;
      const key = pathname.slice(normalizedBase.length + 1);
      if (key === '' || key.includes('/')) continue;
      results.push({
        key,
        size: Number(xmlFirst(block, 'getcontentlength') ?? 0),
        lastModified: xmlFirst(block, 'getlastmodified'),
      });
    }
    return results;
  }

  /** @param {string} key */
  async delete(key) {
    const url = this.urlFor(this.keySegments(key));
    const response = await httpRequest(url, { method: 'DELETE', headers: this.authHeaders(), timeoutMs: 30_000 });
    if (!response.ok && response.status !== 404) {
      throw new Error(t('WebDAV 删除失败（HTTP {status}）: {path}', { status: response.status, path: url.pathname }));
    }
  }

  async test() {
    try {
      await this.ensureCollection(this.prefixSegments());
      const probeKey = '.dsh-sync-probe';
      await this.put(probeKey, Buffer.from(`probe ${new Date().toISOString()}`), 'text/plain');
      const read = await this.get(probeKey);
      await this.delete(probeKey);
      return {
        ok: true,
        message: t('已连接 {label}，前缀 {prefix} 读写正常（回读 {n} 字节）。', { label: this.label, prefix: this.prefix || '(根目录)', n: read?.length ?? 0 }),
      };
    } catch (error) {
      return { ok: false, message: t('连接 {label} 失败: {message}', { label: this.label, message: error.message }) };
    }
  }
}
