import assert from 'node:assert/strict';
import test from 'node:test';

import { formProfile, patchFromForm } from '../lib/api.js';
import { defaultProfile } from '../lib/config.js';
import { validatePassphrase, passphraseProblem } from '../lib/passphrase.js';

test('formProfile returns non-secret values but never stored secrets', () => {
  const profile = defaultProfile('家里的 R2');
  profile.target = {
    ...profile.target,
    kind: 's3',
    s3: { endpoint: 'https://r2.example', region: 'auto', bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: 'super-secret', pathStyle: true },
  };
  profile.passphrase = 'another-secret';
  const view = formProfile(profile);
  const text = JSON.stringify(view);
  assert.ok(!text.includes('super-secret'));
  assert.ok(!text.includes('another-secret'));
  assert.equal(view.target.s3.secretSet, true);
  assert.equal(view.passphraseSet, true);
  assert.equal(view.target.s3.accessKeyId, 'AKIA');
  assert.equal(view.name, '家里的 R2');
});

test('patchFromForm keeps stored secrets when the field is left blank', () => {
  const patch = patchFromForm({
    target: { kind: 's3', prefix: 'dsh-sync', s3: { bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: '', endpoint: '', region: 'auto', pathStyle: true } },
    passphrase: '',
    schedule: { enabled: true, intervalMinutes: 15 },
  });
  assert.equal('secretAccessKey' in patch.target.s3, false);
  assert.equal('passphrase' in patch, false);
  assert.equal(patch.schedule.intervalMinutes, 15);
});

test('patchFromForm switches target kinds cleanly', () => {
  const patch = patchFromForm({
    target: { kind: 'local', prefix: 'dsh-sync', local: { path: 'D:\\backup' }, s3: { bucket: 'stale' } },
    passphrase: 'Aa1@passphrase',
  });
  assert.deepEqual(patch.target.local, { path: 'D:\\backup' });
  assert.equal('s3' in patch.target, false);
  assert.equal('webdav' in patch.target, false);
  assert.equal(patch.passphrase, 'Aa1@passphrase');
});

test('passphrase rules require length, case, digit and an allowed symbol', () => {
  assert.equal(validatePassphrase('Aa1@passphrase').ok, true);
  assert.equal(validatePassphrase('AA1@PASSPHRASE').ok, false, 'needs a lowercase letter');
  assert.equal(validatePassphrase('aa1@passphrase').ok, false, 'needs an uppercase letter');
  assert.equal(validatePassphrase('Aa@passphrase').ok, false, 'needs a digit');
  assert.equal(validatePassphrase('Aa1passphrase').ok, false, 'needs a special character');
  assert.equal(validatePassphrase('Aa1!passphrase').ok, false, '! is outside the allowed symbol set');
  assert.equal(validatePassphrase('Aa1@pass phrase').ok, false, 'spaces are not allowed');

  const short = validatePassphrase('Aa1@x');
  assert.equal(short.ok, false);
  assert.ok(short.errors.some((text) => text.includes('至少 8 位')));
});

test('a letters+digits passphrase is rejected only for the missing symbol, not for its characters', () => {
  const result = validatePassphrase('Abc12345');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['至少 1 个特殊符号（@ # $ * - _）']);
  assert.deepEqual(result.invalidCharacters, []);
  assert.match(passphraseProblem('Abc12345'), /还缺：至少 1 个特殊符号/);
  assert.ok(!passphraseProblem('Abc12345').includes('不允许的字符'));
});

test('illegal characters are named instead of being reported as a rule failure', () => {
  const trailingSpace = validatePassphrase('Abc12345@ ');
  assert.equal(trailingSpace.ok, false);
  assert.deepEqual(trailingSpace.invalidCharacters, [' ']);
  assert.deepEqual(trailingSpace.missing, []);
  assert.ok(passphraseProblem('Abc12345@ ').includes('不允许的字符：空格'));

  const fullWidth = validatePassphrase('Ａbc12345@');
  assert.ok(fullWidth.invalidCharacters.includes('Ａ'));
  assert.match(passphraseProblem('Ａbc12345@'), /U\+FF21/);

  const bang = validatePassphrase('Abc12345!');
  assert.deepEqual(bang.invalidCharacters, ['!']);
  assert.match(passphraseProblem('Abc12345!'), /「!」/);
});
