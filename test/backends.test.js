import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalBackend } from '../lib/backends/local.js';
import { S3Backend } from '../lib/backends/s3.js';
import { WebDavBackend } from '../lib/backends/webdav.js';

/** Start a throwaway HTTP server and return its origin plus a close helper. */
async function listen(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('S3 backend signs, uploads, lists and deletes against a path-style endpoint', async (t) => {
  /** @type {Map<string, Buffer>} */
  const store = new Map();
  const seen = [];
  const server = await listen((req, res, body) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization ?? '';
    seen.push({ method: req.method, path: url.pathname, query: url.search, auth });
    if (req.method === 'PUT' && url.pathname.startsWith('/bucket/')) {
      store.set(decodeURIComponent(url.pathname.slice('/bucket/'.length)), body);
      res.writeHead(200, { etag: '"abc"' }).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bucket') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(
          ([key, value]) =>
            `<Contents><Key>${xmlEscape(key)}</Key><Size>${value.length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/xml' }).end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/bucket/')) {
      const key = decodeURIComponent(url.pathname.slice('/bucket/'.length));
      const value = store.get(key);
      if (!value) {
        res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        return;
      }
      res.writeHead(200, { 'content-length': String(value.length), etag: '"abc"' });
      res.end(req.method === 'HEAD' ? undefined : value);
      return;
    }
    if (req.method === 'DELETE') {
      store.delete(decodeURIComponent(url.pathname.slice('/bucket/'.length)));
      res.writeHead(204).end();
      return;
    }
    res.writeHead(400).end('unexpected');
  });
  t.after(() => server.close());

  const backend = new S3Backend(
    {
      endpoint: server.origin,
      region: 'auto',
      bucket: 'bucket',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example-key',
      pathStyle: true,
    },
    'dsh-sync',
  );
  await backend.put('snapshots/a b.dshsync', Buffer.from('hello'), 'application/octet-stream');
  assert.ok(store.has('dsh-sync/snapshots/a b.dshsync'));
  assert.equal((await backend.get('snapshots/a b.dshsync')).toString(), 'hello');
  assert.equal(await backend.get('snapshots/none'), null);
  assert.equal((await backend.head('snapshots/a b.dshsync')).size, 5);
  const listed = await backend.list('snapshots/');
  assert.deepEqual(listed.map((item) => item.key), ['snapshots/a b.dshsync']);
  await backend.delete('snapshots/a b.dshsync');
  assert.equal(store.size, 0);

  const signed = seen.filter((entry) => entry.auth);
  assert.ok(signed.length >= 5);
  for (const entry of signed) {
    assert.match(entry.auth, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/);
  }
  assert.ok(seen.some((entry) => entry.query.includes('list-type=2') && entry.query.includes('prefix=dsh-sync%2Fsnapshots%2F')));
});

test('WebDAV backend creates collections, round-trips and lists', async (t) => {
  /** @type {Map<string, Buffer>} */
  const store = new Map();
  const server = await listen((req, res, body) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method === 'MKCOL') {
      res.writeHead(201).end();
      return;
    }
    if (req.method === 'PUT') {
      store.set(pathname, body);
      res.writeHead(201).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const value = store.get(pathname);
      if (!value) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': String(value.length) });
      res.end(req.method === 'HEAD' ? undefined : value);
      return;
    }
    if (req.method === 'PROPFIND') {
      const dir = pathname.endsWith('/') ? pathname : `${pathname}/`;
      const children = [...store.keys()].filter((key) => key.startsWith(dir) && !key.slice(dir.length).includes('/'));
      const responses = children
        .map((key) => {
          const value = store.get(key);
          return `<d:response><d:href>${key.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${value.length}</d:getcontentlength></d:prop></d:propstat></d:response>`;
        })
        .join('');
      res.writeHead(207, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`);
      return;
    }
    if (req.method === 'DELETE') {
      store.delete(pathname);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(400).end('unexpected');
  });
  t.after(() => server.close());

  const backend = new WebDavBackend({ url: `${server.origin}/dav/`, username: 'u', password: 'p' }, 'dsh-sync');
  await backend.ensureCollection(backend.prefixSegments());
  await backend.put('snapshots/x.dshsync', Buffer.from('dav body'), 'application/octet-stream');
  assert.ok(store.has('/dav/dsh-sync/snapshots/x.dshsync'));
  assert.equal((await backend.get('snapshots/x.dshsync')).toString(), 'dav body');
  const listed = await backend.list('snapshots/');
  assert.deepEqual(listed.map((item) => item.key), ['x.dshsync']);
  assert.equal((await backend.head('snapshots/x.dshsync')).size, 8);
  await backend.delete('snapshots/x.dshsync');
  assert.equal(store.size, 0);

  const probe = await backend.test();
  assert.equal(probe.ok, true, probe.message);
});

test('local backend reads, writes, lists and refuses traversal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backend = new LocalBackend({ path: root }, 'dsh-sync');
  const probe = await backend.test();
  assert.equal(probe.ok, true, probe.message);
  await backend.put('snapshots/a.dshsync', Buffer.from('local'));
  assert.equal((await backend.get('snapshots/a.dshsync')).toString(), 'local');
  assert.equal((await backend.head('snapshots/a.dshsync')).size, 5);
  assert.deepEqual((await backend.list('snapshots/')).map((item) => item.key), ['a.dshsync']);
  assert.equal(await backend.get('snapshots/missing'), null);
  await backend.delete('snapshots/a.dshsync');
  assert.equal(await backend.get('snapshots/a.dshsync'), null);
  await assert.rejects(() => backend.put('../escape.txt', Buffer.from('x')), /非法|越界/);
});
