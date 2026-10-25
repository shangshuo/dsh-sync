/** Passphrase rules shared by the settings page and the Host API. */
import { t } from './i18n.js';

export const ALLOWED_PATTERN = /^[A-Za-z0-9@#$*\-_]*$/;
export const ALLOWED_CHAR = /[A-Za-z0-9@#$*\-_]/;

export const PASSPHRASE_RULES = [
  { id: 'length', text: () => t('至少 8 位'), test: (value) => value.length >= 8 },
  { id: 'lower', text: () => t('包含小写字母'), test: (value) => /[a-z]/.test(value) },
  { id: 'upper', text: () => t('包含大写字母'), test: (value) => /[A-Z]/.test(value) },
  { id: 'digit', text: () => t('包含数字'), test: (value) => /[0-9]/.test(value) },
  { id: 'symbol', text: () => t('至少 1 个特殊符号（@ # $ * - _）'), test: (value) => /[@#$*\-_]/.test(value) },
  { id: 'charset', text: () => t('只能使用字母、数字和 @ # $ * - _'), test: (value) => ALLOWED_PATTERN.test(value) },
];

/** Name one offending character so a space or a full-width glyph is visible. */
export function describeCharacter(char) {
  if (char === ' ') return t('空格');
  if (char === '\t') return t('制表符');
  if (char === '\n') return t('换行');
  const code = char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  return t('「{char}」(U+{code})', { char, code });
}

/**
 * Every distinct character outside the allowed set, in first-seen order.
 * @param {string} value
 * @returns {string[]}
 */
export function invalidCharacters(value) {
  const seen = new Set();
  const list = [];
  for (const char of String(value ?? '')) {
    if (ALLOWED_CHAR.test(char) || seen.has(char)) continue;
    seen.add(char);
    list.push(char);
  }
  return list;
}

/**
 * @param {string} value
 * @returns {{ ok: boolean, errors: string[], missing: string[], invalidCharacters: string[], edgeSpaces: boolean }}
 */
export function validatePassphrase(value) {
  const text = typeof value === 'string' ? value : '';
  const missing = PASSPHRASE_RULES.filter((rule) => rule.id !== 'charset' && !rule.test(text)).map((rule) => rule.text());
  const invalid = invalidCharacters(text);
  const errors = [...missing];
  if (invalid.length > 0) errors.push(t('含有不允许的字符：{list}', { list: invalid.map(describeCharacter).join('、') }));
  return {
    ok: errors.length === 0,
    errors,
    missing,
    invalidCharacters: invalid,
    edgeSpaces: text.length > 0 && text !== text.trim(),
  };
}

/** One-line explanation for an API error. */
export function passphraseProblem(value) {
  const result = validatePassphrase(value);
  if (result.ok) return '';
  const parts = [];
  if (result.missing.length > 0) parts.push(t('还缺：{list}', { list: result.missing.join('、') }));
  if (result.invalidCharacters.length > 0) parts.push(t('不允许的字符：{list}', { list: result.invalidCharacters.map(describeCharacter).join('、') }));
  if (result.edgeSpaces) parts.push(t('首尾有空格，口令不会被自动去掉'));
  return t('口令不符合规则。{detail}', { detail: parts.join('；') });
}
