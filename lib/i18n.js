/**
 * Host 侧消息的极简 i18n：中文源文本即键。
 *
 * - 默认语言 zh：t() 直接返回插值后的中文原文，零字典。
 * - 英文：查 EN 表（键 = 中文模板原文），缺失时回退中文——漏翻不会显示错误内容。
 * - 插值：模板中的 {name} 用 params.name 替换（两种语言共用参数名）。
 *
 * 语言来自设置页的每个 HTTP 请求（x-dsh-sync-lang 头），api.js 在处理请求前
 * 调 setLang。Host 是单用户进程，请求级覆盖是可接受的近似；agent 工具调用
 * 未带该头时保持最近一次设置（默认 zh）。
 */

let lang = 'zh';

/** @param {string} value 'zh' | 'en'（其它值一律回退 zh） */
export function setLang(value) {
  lang = value === 'en' ? 'en' : 'zh';
}

/** @returns {'zh'|'en'} */
export function getLang() {
  return lang;
}

/**
 * 英文映射表：键 = 中文模板原文（含 {参数} 占位），值 = 英文译文。
 */
const EN = {
  // config.js · targetProblems
  'S3 bucket 未配置': 'S3 bucket is not configured',
  'S3 accessKeyId 未配置': 'S3 access key ID is not configured',
  'S3 secretAccessKey 未配置': 'S3 secret access key is not configured',
  'WebDAV url 未配置': 'WebDAV URL is not configured',
  '本地目录 path 未配置': 'Local folder path is not configured',
  '尚未选择同步目标（target.kind）': 'No sync target selected yet (target.kind)',
  '同步口令未配置': 'Sync passphrase is not configured',
  '同步口令长度不足 8 位（当前 {n} 位），请重新设置': 'Sync passphrase is shorter than 8 characters (currently {n}); please set it again',
  // config.js · 其它
  '配置名称不能为空': 'Profile name must not be empty',
  '配置名称不能超过 {n} 个字符': 'Profile name must be at most {n} characters',
  '配置名称不能包含 \\ / : * ? " < > |': 'Profile name must not contain \\ / : * ? " < > |',
  '至少保留一个配置': 'At least one profile must remain',
  '配置「{name}」已存在': 'Profile "{name}" already exists',
  '找不到配置「{name}」': 'Profile "{name}" not found',
  '非法的对象前缀: {prefix}': 'Invalid object prefix: {prefix}',
  // secrets.js
  '系统密钥保护（Windows DPAPI / macOS 钥匙串）': 'Protected by OS keychain (Windows DPAPI / macOS Keychain)',
  '环境变量 {name} 派生的密钥（AES-256-GCM）': 'Key derived from environment variable {name} (AES-256-GCM)',
  '本地密钥文件（AES-256-GCM，仅防误读，不能防同机读取）': 'Local key file (AES-256-GCM; deters casual reading only, not same-user access)',
  '系统密钥不可用原因：{detail}': 'OS keychain unavailable because: {detail}',
  '加密配置已损坏': 'Encrypted config is corrupted',
  '这份配置由系统密钥保护，但当前进程无法访问系统密钥（换机器或换了系统用户？）。请重新填写同步配置。': 'This config was protected by the OS keychain, which this process cannot access (different machine or OS user?). Please re-enter your sync settings.',
  '这份配置由环境变量 {name} 派生密钥加密，请先设置该变量': 'This config was encrypted with a key derived from env var {name}; set it first',
  '找不到本地密钥文件 {path}，无法解密已保存的配置': 'Local key file {path} not found; cannot decrypt the saved config',
  '配置加密密钥不可用': 'Config encryption key is unavailable',
  '配置文件缺少密文': 'Config file has no encrypted blob',
  '未知的配置加密格式: {cipher}': 'Unknown config encryption format: {cipher}',
  // passphrase.js
  '还缺：{list}': 'Still missing: {list}',
  '不允许的字符：{list}': 'Disallowed characters: {list}',
  '含有不允许的字符：{list}': 'Contains disallowed characters: {list}',
  '首尾有空格，口令不会被自动去掉': 'Has leading/trailing spaces; they will not be stripped',
  '口令不符合规则。{detail}': 'Passphrase does not meet the rules. {detail}',
  '空格': 'space',
  '制表符': 'tab',
  '换行': 'newline',
  '「{char}」(U+{code})': '"{char}" (U+{code})',
  '至少 8 位': 'At least 8 characters',
  '包含小写字母': 'Contains a lowercase letter',
  '包含大写字母': 'Contains an uppercase letter',
  '包含数字': 'Contains a digit',
  '至少 1 个特殊符号（@ # $ * - _）': 'At least 1 symbol (@ # $ * - _)',
  '只能使用字母、数字和 @ # $ * - _': 'Letters, digits and @ # $ * - _ only',
  // engine.js · push/容器
  '配置「{name}」还不完整：{detail}': 'Profile "{name}" is incomplete: {detail}',
  '内容与上次备份完全一致，未上传新快照。': 'Content is identical to the last backup; no new snapshot uploaded.',
  '口令错误，或归档已被篡改（HMAC 校验失败）': 'Wrong passphrase, or the archive was tampered with (HMAC verification failed)',
  '同步口令未配置或太短（至少 8 个字符）。口令用于加密云端归档，请用 sync_configure 设置。': 'Sync passphrase is missing or too short (at least 8 characters). It encrypts the cloud archive; set it with sync_configure.',
  '不是有效的 DSH Sync 归档（文件太小）': 'Not a valid DSH Sync archive (file too small)',
  '不是有效的 DSH Sync 归档（魔数不匹配）': 'Not a valid DSH Sync archive (magic mismatch)',
  'DSH Sync 归档头损坏': 'DSH Sync archive header is corrupted',
  'DSH Sync 归档头不是合法 JSON: {message}': 'DSH Sync archive header is not valid JSON: {message}',
  '不支持的归档版本: {format}': 'Unsupported archive version: {format}',
  'DSH Sync 归档缺少条目表': 'DSH Sync archive is missing its entry table',
  '条目 {path} 的数据被截断': 'Entry {path} is truncated',
  '条目 {path} 校验失败': 'Entry {path} failed checksum verification',
  '未知条目类型: {type} ({path})': 'Unknown entry type: {type} ({path})',
  '不是 DSH Sync 加密归档（可能是旧版本或被截断）': 'Not a DSH Sync encrypted archive (wrong version or truncated)',
  '不支持的归档加密格式: {cipher}': 'Unsupported archive encryption format: {cipher}',
  '归档解压失败: {message}': 'Failed to decompress archive: {message}',
  'entry {path} has no content': 'entry {path} has no content',
  'entry {path} size mismatch': 'entry {path} size mismatch',
  // engine.js · pull/恢复
  '恢复会覆盖本机配置。请先以 dryRun（默认）预览，再带 confirm: true 重试。': 'A restore overwrites local config. Preview with dryRun (default) first, then retry with confirm: true.',
  '远端没有找到快照：先执行一次备份，或用 sync_snapshots 查看。': 'No snapshot found on the target: back up first, or check with sync_snapshots.',
  '快照 {size} 超过上限，已拒绝下载。': 'Snapshot {size} exceeds the limit; download refused.',
  '快照不存在: {key}': 'Snapshot does not exist: {key}',
  '快照与 latest.json 记录的校验值不一致（下载损坏或被篡改）。': 'Snapshot does not match the checksum in latest.json (corrupted download or tampered).',
  '归档内包含非法路径: {path}': 'Archive contains an illegal path: {path}',
  '归档条目越界: {path}': 'Archive entry escapes its root: {path}',
  '请填写 .dshsync 快照文件，或包含快照的目录': 'Specify a .dshsync snapshot file, or a folder that contains one',
  '路径不存在：{path}': 'Path does not exist: {path}',
  '请选择 .dshsync 快照文件': 'Please choose a .dshsync snapshot file',
  '不支持的路径类型：{path}': 'Unsupported path type: {path}',
  '这个目录里没有 .dshsync 快照：{path}': 'No .dshsync snapshot in this folder: {path}',
  '目录里有 {n} 个快照，请直接选择其中一个文件：{list}': 'This folder has {n} snapshots; pick one file directly: {list}',
  '快照超过 {limit} 上限。可以关闭 node_modules 同步、减少 extraPaths，或提高 limits.maxArchiveMB。': 'Snapshot exceeds the {limit} limit. Turn off node_modules sync, trim extraPaths, or raise limits.maxArchiveMB.',
  '文件超过 {limit}，已跳过：{name}': 'File over {limit}, skipped: {name}',
  '文件数超过上限 {n}，其余文件未纳入快照。可提高 limits.maxFiles。': 'File count exceeds the limit of {n}; the rest were left out. Raise limits.maxFiles to include them.',
  '来源不存在，已跳过：{label}（{path}）': 'Source missing, skipped: {label} ({path})',
  '快照里的以下内容不在本机当前的备份范围内（{modules}），已跳过 {n} 个条目。': 'The following snapshot content is outside this machine\'s current backup scope ({modules}); {n} entries skipped.',
  '这个快照来自配置「{profile}」，当前配置是「{name}」，请确认目标与口令是否对应。': 'This snapshot came from profile "{profile}" while the active one is "{name}"; double-check the target and passphrase.',
  '本地插件 {name} 在本机的链接仍然有效，保留了本机版本；快照中的副本未释放。': 'Local plugin {name} still has a working link here; the local copy was kept and the snapshot copy was not unpacked.',
  '本地插件 {name} 已从快照释放并重新链接（{path}）': 'Local plugin {name} was unpacked from the snapshot and re-linked ({path})',
  '保留了本机的插件依赖 {name}（快照里的路径 {path} 在本机不存在）': 'Kept the local dependency {name} (snapshot path {path} does not exist here)',
  '本地插件 {name} 的源路径（{path}）在本机不存在，且快照未包含其源码，需要手工重新安装。': 'Local plugin {name} points to {path}, which does not exist here, and the snapshot has no copy of it; reinstall it manually.',
  '凭证已合并：保留了本机的设备绑定记录。': 'Credentials merged: device-bound records on this machine were kept.',
  '无法创建符号链接 {path} -> {link}: {message}': 'Cannot create symlink {path} -> {link}: {message}',
  '写入校验失败: {path}': 'Write verification failed: {path}',
  '需要安装 {n} 个插件包，但当前环境无法调用包管理器；请重启 DSH 后在插件管理器中安装。': '{n} plugin package(s) need installing, but no package manager is available here; restart DSH and install them in the plugin manager.',
  '插件依赖安装失败：{message}': 'Plugin dependency install failed: {message}',
  '无法启动包管理器 {command}: {message}': 'Cannot start package manager {command}: {message}',
  '插件依赖安装超时（10 分钟）。': 'Plugin dependency install timed out (10 minutes).',
  '包管理器退出码 {code}。{tail}': 'Package manager exited with code {code}. {tail}',
  '依赖安装完成（{command} install）。': 'Dependencies installed ({command} install).',
  // collect.js · 模块
  'DSH 配置档案': 'DSH profile',
  '本地目录插件': 'Local-folder plugins',
  '机器级补丁': 'Machine-level patch',
  'DSH 自建技能': 'DSH home skills',
  '跨工具技能': 'Cross-tool skills',
  '桌面界面偏好': 'Desktop UI preferences',
  '技能管理器设置': 'Skill manager settings',
  'MCP 连接器（含令牌）': 'MCP connector (contains tokens)',
  '工作区根依赖': 'Workspace root dependencies',
  '凭证与 API Key': 'Credentials & API keys',
  '插件代码（node_modules）': 'Plugin code (node_modules)',
  '插件清单与全部插件设置（package.json、cordis.patch.yml、pnpm 配置、市场设置）。恢复后缺失的插件包会自动安装': 'Plugin manifest and every plugin setting (package.json, cordis.patch.yml, pnpm config, marketplace settings). Missing plugin packages are installed automatically on restore',
  '以 link:/file: 方式安装的非市场插件源码（不含各自的 node_modules）。恢复时自动释放并重新链接，无需手工重装——代价是备份体积相应增大': 'Source of non-marketplace plugins installed via link:/file: (without their node_modules). Unpacked and re-linked automatically on restore, no manual reinstall—backups get larger accordingly',
  '~/.dsh/cordis.patch.yml，对所有 profile 生效的用户层配置': '~/.dsh/cordis.patch.yml, the user-level patch applied to every profile',
  '~/.dsh/skills 目录（不存在时自动跳过）': '~/.dsh/skills folder (skipped automatically when absent)',
  '~/.agents/skills 目录，与其它 agent 工具共享': '~/.agents/skills folder, shared with other agent tools',
  '窗口缩放、音效、气泡开关等（.dshw-size.json）': 'Window zoom, sound effects, bubble toggles, etc. (.dshw-size.json)',
  '技能来源开关与禁用列表（skills-manager、dsh-skill-explorer）': 'Skill source toggles and disabled list (skills-manager, dsh-skill-explorer)',
  '桌面版 MCP 服务器连接与授权（storages/mcp_connector.json）。文件可能包含访问令牌，默认不备份': 'Desktop MCP server connections and grants (storages/mcp_connector.json). May contain access tokens; off by default',
  'profiles/package.json（含市场插件依赖），一般可由 DSH 重建': 'profiles/package.json (marketplace plugin dependencies); DSH can usually rebuild it',
  '.credentials.yaml 与 .env。设备绑定记录永远不上传': '.credentials.yaml and .env. Device-bound records are never uploaded',
  '离线可还原，体积大；默认靠恢复时自动 pnpm 安装': 'Offline restorable but large; by default plugins are reinstalled via pnpm on restore',
  '附加目录 {name}': 'Extra folder {name}',
  // backends
  '尚未配置同步目标：先用 sync_configure 设置 target.kind（s3 / webdav / local）': 'No sync target configured yet: set target.kind (s3 / webdav / local) with sync_configure first',
  '本地目录同步目标缺少 path': 'Local folder target is missing path',
  '非法的对象键: {key}': 'Illegal object key: {key}',
  '对象键越界: {key}': 'Object key escapes the root: {key}',
  'WebDAV 配置缺少 url': 'WebDAV config is missing url',
  'WebDAV 创建目录失败（HTTP {status}）: {path}': 'WebDAV MKCOL failed (HTTP {status}): {path}',
  'WebDAV 上传失败（HTTP {status}）: {path}': 'WebDAV upload failed (HTTP {status}): {path}',
  'WebDAV 上传失败：父目录不可用 {path}': 'WebDAV upload failed: parent collection unavailable {path}',
  'WebDAV 下载失败（HTTP {status}）: {path}': 'WebDAV download failed (HTTP {status}): {path}',
  'WebDAV HEAD 失败（HTTP {status}）: {path}': 'WebDAV HEAD failed (HTTP {status}): {path}',
  'WebDAV 列目录失败（HTTP {status}）: {path}': 'WebDAV PROPFIND failed (HTTP {status}): {path}',
  'WebDAV 删除失败（HTTP {status}）: {path}': 'WebDAV DELETE failed (HTTP {status}): {path}',
  'S3 配置缺少 endpoint（Cloudflare R2 / MinIO / Backblaze 等必须填写 endpoint）': 'S3 config is missing the endpoint (required for Cloudflare R2 / MinIO / Backblaze, etc.)',
  'S3 请求失败: {code} - {message}（HTTP {status}）': 'S3 request failed: {code} - {message} (HTTP {status})',
  '网络请求失败: {message}{cause}': 'Network request failed: {message}{cause}',
  '请求超时（{n} 秒）': 'Request timed out ({n}s)',
  '请求 {method} {url} 超时或被取消': 'Request {method} {url} timed out or was cancelled',
  '已连接 {label}，目录 {path} 可读写（探测文件 {size}）。': 'Connected to {label}; folder {path} is writable (probe file {size}).',
  '连接 {label} 失败: {message}': 'Connecting to {label} failed: {message}',
  '已连接 {label}，前缀 {prefix} 读写正常（回读 {n} 字节）。': 'Connected to {label}; prefix {prefix} reads and writes (read back {n} bytes).',
  '已连接 {label}，前缀 {prefix}/ 下现有 {n} 个对象，读写正常（探测对象 {size}）。': 'Connected to {label}; {n} objects under prefix {prefix}/, reads and writes fine (probe object {size}).',
  '当前系统没有可用的文件选择器（zenity/kdialog），请手动填写路径。': 'No file picker available on this system (zenity/kdialog); type the path manually.',
  '选择窗口超时': 'The picker window timed out',
  // api.js
  '只接受 POST': 'Only POST is accepted',
  '缺少 DSH Sync 请求头': 'Missing the DSH Sync header',
  '跨站请求被拒绝': 'Cross-site requests are rejected',
  '请求体超过 1 MB': 'Request body exceeds 1 MB',
  '请求体不是合法 JSON': 'Request body is not valid JSON',
  '未知操作: {action}': 'Unknown action: {action}',
  '找不到配置「{name}」': 'Profile "{name}" not found',
  // tools.js
  '配置完整。接下来可 sync_test 验证连通性，再 sync_push 备份。': 'Profile complete. Run sync_test to verify connectivity, then sync_push to back up.',
  '配置仍不完整；补齐后再 sync_test / sync_push。': 'Profile is still incomplete; complete it before sync_test / sync_push.',
  // status
  '未知': 'Unknown',
  '已设置': 'Set',
  'unset': 'unset',
  '环境变量 {name}': 'env var {name}',
};

/**
 * 翻译：中文模板原文作键。zh 直接插值返回；en 查表（缺表项回退中文）。
 * @param {string} template 中文模板，如 '配置「{name}」还不完整'
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(template, params = {}) {
  const pattern = lang === 'en' ? EN[template] : undefined;
  const text = pattern ?? template;
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
}
