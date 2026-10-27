import assert from 'node:assert/strict';
import test from 'node:test';

import { openArchive, packContainer, sealArchive, unpackContainer } from '../lib/container.js';
import { mergeCredentialRecords, splitCredentialRecords, stripDeviceRecords } from '../lib/credentials.js';
import { canonicalQuery, canonicalUri, signV4 } from '../lib/backends/s3.js';
import { sha256Hex } from '../lib/util.js';

test('container round-trips files, directories and symlinks', () => {
  const files = [
    { path: 'profile/cordis.patch.yml', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('hello: world\n') },
    { path: 'profile', type: 'dir', mode: 0o755, size: 0, sha256: '' },
    { path: 'skills-dsh/demo/SKILL.md', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('# demo\n') },
    { path: 'profile/link', type: 'symlink', mode: 0o777, size: 0, sha256: '', link: '../target' },
  ];
  for (const file of files) {
    if (file.type === 'file') {
      file.size = file.data.length;
      file.sha256 = sha256Hex(file.data);
    }
  }
  const header = { createdAt: '2026-01-01T00:00:00.000Z', profile: 'desktop', counts: { files: 2 } };
  const packed = packContainer(header, files);
  const { header: restoredHeader, entries } = unpackContainer(packed);
  assert.equal(restoredHeader.profile, 'desktop');
  assert.equal(entries.length, 4);
  assert.equal(entries[0].data.toString(), 'hello: world\n');
  assert.equal(entries[3].link, '../target');
});

test('a symlink before a file does not shift the following payload', () => {
  const link = '../target/some/long/link';
  const files = [
    { path: 'skills-agents/alpha/link', type: 'symlink', mode: 0o777, size: 0, sha256: sha256Hex(link), link },
    { path: 'skills-agents/alpha/LICENSE', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('MIT License\n') },
    { path: 'skills-agents/alpha/SKILL.md', type: 'file', mode: 0o644, size: 0, sha256: '', data: Buffer.from('# demo\n') },
  ];
  for (const file of files) {
    if (file.type === 'file') {
      file.size = file.data.length;
      file.sha256 = sha256Hex(file.data);
    }
  }
  const { entries } = unpackContainer(packContainer({ profile: 'x' }, files));
  assert.equal(entries.length, 3);
  assert.equal(entries[0].link, link);
  assert.equal(entries[1].data.toString(), 'MIT License\n');
  assert.equal(entries[2].data.toString(), '# demo\n');
});

test('sealed archive needs the right passphrase and detects tampering', () => {
  const plain = packContainer({ profile: 'desktop' }, [
    { path: 'a.txt', type: 'file', mode: 0o644, size: 3, sha256: sha256Hex(Buffer.from('abc')), data: Buffer.from('abc') },
  ]);
  const envelope = sealArchive(plain, 'correct horse battery staple');
  const opened = openArchive(envelope, 'correct horse battery staple');
  assert.equal(opened.header.format, 'dsh-sync/2');
  assert.ok(opened.plain.equals(plain));

  assert.throws(() => openArchive(envelope, 'wrong passphrase'), /口令错误|HMAC/);

  const tampered = Buffer.from(envelope);
  tampered[tampered.length - 40] ^= 0xff;
  assert.throws(() => openArchive(tampered, 'correct horse battery staple'), /口令错误|HMAC/);
});

test('credentials keep device records on the local machine only', () => {
  const text = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: secret',
    '    payload:',
    '      secret: browser',
    '  deepseek-account-platform/device:',
    '    kind: json',
    '    payload:',
    '      id: device-1',
    '  deepseek-account-platform/default:',
    '    kind: json',
    '    payload:',
    '      token: token-1',
    '',
  ].join('\n');
  const portable = stripDeviceRecords(text);
  assert.ok(!portable.includes('browser-session'));
  assert.ok(!portable.includes('device-1'));
  assert.ok(portable.includes('token-1'));

  const parsed = splitCredentialRecords(text);
  assert.equal(parsed.records.length, 3);

  const local = text.replace('token-1', 'token-local');
  const merged = mergeCredentialRecords(local, portable);
  assert.ok(merged !== null);
  assert.ok(merged.includes('device-1'));
  assert.ok(merged.includes('token-1'));
  assert.ok(!merged.includes('token-local'));
});

test('SigV4 matches the published AWS example (GET object with range)', () => {
  const date = new Date('2013-05-24T00:00:00Z');
  const { authorization } = signV4({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    // AWS SigV4 文档的公开测试向量（非真实凭据；拆分书写以避免凭据扫描误报）
    accessKeyId: `AKIA${'IOSFODNN7EXAMPLE'}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'EXAMPLEKEY'}`,
    region: 'us-east-1',
    date,
  });
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('canonical URI and query encoding follow AWS rules', () => {
  assert.equal(canonicalUri('/dsh-sync/snapshots/a b+c.dshsync'), '/dsh-sync/snapshots/a%20b%2Bc.dshsync');
  const query = new URLSearchParams();
  query.set('prefix', 'dsh-sync/');
  query.set('list-type', '2');
  assert.equal(canonicalQuery(query), 'list-type=2&prefix=dsh-sync%2F');
});
