import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { httpRequest } from '../lib/http.js';

/** @param {http.RequestListener} handler */
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a request that stops making progress is aborted by the stall timeout', async (t) => {
  // 只接受连接、从不响应：模拟链路卡死（而不是“整体太慢”）。
  const server = await listen(() => undefined);
  t.after(() => server.close());
  const started = Date.now();
  await assert.rejects(
    () => httpRequest(new URL(`${server.origin}/hang`), { timeoutMs: 0, stallTimeoutMs: 300 }),
    /超时或被取消|timed out or was cancelled/,
  );
  assert.ok(Date.now() - started < 5000, 'stall timeout should fire promptly');
});
