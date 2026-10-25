/**
 * `.credentials.yaml` is device-bound in places: the browser session secret and the
 * device identity must stay on the machine that created them. These helpers keep the
 * portable records (API keys, account token) and leave device records alone.
 */

export const DEVICE_BOUND_RECORDS = new Set(['client-connection/browser-session', 'deepseek-account-platform/device']);

/**
 * Split a credentials file into its prelude and top-level record blocks.
 * @param {string} text
 * @returns {{ prelude: string[], records: { key: string, lines: string[] }[] }}
 */
export function splitCredentialRecords(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^records:\s*$/.test(line));
  if (start < 0) return { prelude: lines, records: [] };
  const prelude = lines.slice(0, start + 1);
  /** @type {{ key: string, lines: string[] }[]} */
  const records = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line)) {
      if (current) current.lines.push(line);
      continue;
    }
    const match = line.match(/^ {2}([^\s#][^:]*):\s*$/);
    if (match) {
      if (current) records.push(current);
      current = { key: match[1].trim(), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
    else prelude.push(line);
  }
  if (current) records.push(current);
  return { prelude, records };
}

/**
 * Remove device-bound records and return portable YAML text.
 * @param {string} text
 * @returns {string}
 */
export function stripDeviceRecords(text) {
  const { prelude, records } = splitCredentialRecords(text);
  const kept = records.filter((record) => !DEVICE_BOUND_RECORDS.has(record.key));
  const body = kept.map((record) => record.lines.join('\n').replace(/\n+$/, '')).join('\n');
  return `${prelude.join('\n').replace(/\n+$/, '')}\n${body}${body ? '\n' : ''}`;
}

/**
 * Merge portable records from a snapshot into the local credentials file, keeping the
 * local device-bound records. Returns null when nothing would change.
 * @param {string} localText
 * @param {string} remoteText
 * @returns {string | null}
 */
export function mergeCredentialRecords(localText, remoteText) {
  const local = splitCredentialRecords(localText);
  const remote = splitCredentialRecords(remoteText);
  const localDevice = local.records.filter((record) => DEVICE_BOUND_RECORDS.has(record.key));
  const remotePortable = remote.records.filter((record) => !DEVICE_BOUND_RECORDS.has(record.key));
  /** @type {Map<string, { key: string, lines: string[] }>} */
  const merged = new Map();
  for (const record of remotePortable) merged.set(record.key, record);
  for (const record of localDevice) merged.set(record.key, record);
  const ordered = [...merged.values()];
  const prelude = (remote.prelude.length > 1 ? remote.prelude : local.prelude).join('\n').replace(/\n+$/, '');
  const body = ordered.map((record) => record.lines.join('\n').replace(/\n+$/, '')).join('\n');
  const text = `${prelude}\n${body}${body ? '\n' : ''}`;
  return text === localText ? null : text;
}
