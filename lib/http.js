/** Minimal HTTP helper used by the remote backends (global fetch, Node 20+). */
import { t } from './i18n.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable, Transform } from 'node:stream';

/** @param {string} method @param {string | URL} url */
function timeoutError(method, url) {
  return new Error(t('请求 {method} {url} 超时或被取消', { method, url: String(url) }));
}

/**
 * @param {string | URL} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: Buffer | Uint8Array | string | Readable,
 *   timeoutMs?: number,
 *   stallTimeoutMs?: number,
 *   redirect?: RequestRedirect,
 * }} options
 *
 * `body` 传 Readable 时按流式发送（调用方需自行带 content-length）。
 * `timeoutMs` 是整次请求的总时限；`stallTimeoutMs` 是「多久没有发出/收到任何字节」的停滞时限。
 * 只给 stallTimeoutMs 时不设总时限——大文件在慢速链路上只要还在动就不会被掐断。
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, body: Buffer, text: string }>}
 */
export async function httpRequest(url, options = {}) {
  const method = options.method ?? 'GET';
  const stallTimeoutMs = Math.max(0, Number(options.stallTimeoutMs ?? 0));
  const timeoutMs = options.timeoutMs ?? (stallTimeoutMs > 0 ? 0 : 60_000);
  const controller = new AbortController();
  let lastActivity = Date.now();
  /** @type {NodeJS.Timeout | undefined} */
  let stallTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let totalTimer;
  if (stallTimeoutMs > 0) {
    stallTimer = setInterval(() => {
      if (Date.now() - lastActivity >= stallTimeoutMs) controller.abort(timeoutError(method, url));
    }, Math.max(250, Math.min(1000, stallTimeoutMs)));
    stallTimer.unref?.();
  }
  if (timeoutMs > 0) {
    totalTimer = setTimeout(() => controller.abort(timeoutError(method, url)), timeoutMs);
  }

  const streaming = options.body instanceof Readable;
  let body = options.body;
  if (streaming) {
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        lastActivity = Date.now();
        callback(null, chunk);
      },
    });
    options.body.pipe(meter);
    body = Readable.toWeb(meter);
  }

  try {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body,
      redirect: options.redirect ?? 'follow',
      signal: controller.signal,
      ...(streaming ? { duplex: 'half' } : {}),
    });
    const chunks = [];
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        if (value) chunks.push(Buffer.from(value));
      }
    }
    const buffer = Buffer.concat(chunks);
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: buffer,
      text: buffer.length > 0 ? buffer.toString('utf8') : '',
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      throw timeoutError(method, url);
    }
    const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(t('网络请求失败: {message}{cause}', { message: error?.message ?? error, cause }));
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/** Retry a network operation a few times on transient failures. */
export async function withRetry(fn, { attempts = 3, baseDelayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await delay(baseDelayMs * attempt);
    }
  }
  throw lastError;
}
