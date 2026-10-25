/** Minimal HTTP helper used by the remote backends (global fetch, Node 20+). */
import { t } from './i18n.js';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * @param {string | URL} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: Buffer | Uint8Array | string, timeoutMs?: number, redirect?: RequestRedirect }} options
 * @returns {Promise<{ status: number, ok: boolean, headers: Headers, body: Buffer, text: string }>}
 */
export async function httpRequest(url, options = {}) {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(t('请求超时（{n} 秒）', { n: Math.round(timeoutMs / 1000) }))), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect ?? 'follow',
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: buffer,
      text: buffer.length > 0 ? buffer.toString('utf8') : '',
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(t('请求 {method} {url} 超时或被取消', { method, url: String(url) }));
    }
    const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
    throw new Error(t('网络请求失败: {message}{cause}', { message: error?.message ?? error, cause }));
  } finally {
    clearTimeout(timer);
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
