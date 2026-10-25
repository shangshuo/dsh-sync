import assert from 'node:assert/strict';
import test from 'node:test';

import { getLang, setLang, t } from '../lib/i18n.js';

test('t() returns the Chinese source text by default and interpolates params', () => {
  setLang('zh');
  assert.equal(t('配置「{name}」还不完整：{detail}', { name: 'X', detail: 'a；b' }), '配置「X」还不完整：a；b');
  assert.equal(t('同步口令未配置'), '同步口令未配置');
});

test('t() switches to English via the mapping table and falls back for missing entries', () => {
  setLang('en');
  try {
    assert.equal(t('同步口令未配置'), 'Sync passphrase is not configured');
    assert.equal(t('配置「{name}」还不完整：{detail}', { name: 'X', detail: 'a; b' }), 'Profile "X" is incomplete: a; b');
    // 未收录的条目回退中文原文（漏翻不显示错误内容）
    assert.equal(t('这是一句没有收录的话'), '这是一句没有收录的话');
    assert.equal(getLang(), 'en');
  } finally {
    setLang('zh');
  }
});

test('unknown lang values fall back to Chinese', () => {
  setLang('ja');
  assert.equal(getLang(), 'zh');
  setLang('en');
  setLang('zh');
  assert.equal(getLang(), 'zh');
});
