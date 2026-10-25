/** Backend factory: one small interface over S3, WebDAV and a local folder. */
import { t } from '../i18n.js';
import { normalizePrefix } from '../config.js';
import { LocalBackend } from './local.js';
import { S3Backend } from './s3.js';
import { WebDavBackend } from './webdav.js';

/**
 * @param {any} config
 * @returns {{ kind: 's3'|'webdav'|'local', label: string, prefix: string, put: Function, get: Function, head: Function, list: Function, delete: Function, test: Function }}
 */
export function createBackend(config) {
  const target = config.target ?? {};
  const prefix = normalizePrefix(target.prefix ?? 'dsh-sync');
  switch (target.kind) {
    case 's3':
      return new S3Backend(target.s3, prefix);
    case 'webdav':
      return new WebDavBackend(target.webdav, prefix);
    case 'local':
      return new LocalBackend(target.local, prefix);
    default:
      throw new Error(t('尚未配置同步目标：先用 sync_configure 设置 target.kind（s3 / webdav / local）'));
  }
}
