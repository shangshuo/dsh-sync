# DSH Sync · DSH 配置同步插件

把一整台机器上的 DSH「个人状态」加密备份到云端，换电脑后一条命令还原：插件、插件设置、模型与界面偏好、MCP 服务器、自建 skill、API Key，全都在里面。

- **一个归档**：所有配置打包成一个加密文件，云端只看到密文。
- **三种目标**：S3 兼容对象存储、WebDAV、本地同步目录（iCloud/OneDrive/坚果云/NAS）。
- **内容可选**：备份内容拆成 11 个模块，设置页逐项开关并实时显示体积；隐私模块（MCP 连接器、API Key）默认关闭，开启需确认隐私声明。
- **定时同步**：按分钟级间隔自动备份，内容没变就不上传。
- **可回滚**：恢复前自动备份本机文件，从不删除本机独有的文件。
- **中英文界面**：跟随 DSH 的语言设置自动切换（切换即时生效，无需重启），未收录文案自动回退中文。

---

## 1. 它同步什么（0.4 模块化）

备份内容拆成模块，在 设置 → 同步 → 备份 → 备份内容 里逐项开关（含实时文件数/体积）：

| 模块 | 归档前缀 | 本机来源 | 默认 | 内容 |
| --- | --- | --- | --- | --- |
| DSH 配置档案 | `profile/` | `profiles/<profile>/` 白名单 | **必选** | `package.json`（插件清单）、`cordis.patch.yml`（**所有插件配置、MCP 服务器、模型/界面偏好**）、`cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.dsh-market/state.json` |
| 本地目录插件 | `local-plugins/` | `link:`/`file:` 依赖的源目录 | 开 | 非市场插件源码（不含各自 node_modules）。恢复时自动释放并重新链接，**无需手工重装**；会增大备份体积 |
| 机器级补丁 | `home/` | `$DSH_HOME/cordis.patch.yml` | 开 | 用户级 patch |
| DSH 自建技能 | `skills-dsh/` | `$DSH_HOME/skills/` | 开 | 自建 skill（目录不存在自动跳过） |
| 跨工具技能 | `skills-agents/` | `~/.agents/skills/` | 开 | 跨工具共享 skill |
| 桌面界面偏好 | `ui/` | `$DSH_HOME/.dshw-size.json` | 开 | 窗口缩放、音效、气泡等 |
| 技能管理器设置 | `skill-manager/` | `skills-manager/state.json`、`dsh-skill-explorer/provider-toggles.json` | 开 | 技能来源开关与禁用列表 |
| MCP 连接器 | `mcp/` | `storages/mcp_connector.json` | **关** ⚠️ | 桌面版 MCP 连接与授权，**可能含访问令牌**（隐私声明见下） |
| 工作区根依赖 | `workspace-root/` | `profiles/package.json` | 关 | workspace 根的 `dshmarket` 依赖，一般可由 DSH 重建 |
| 凭证与 API Key | `credentials/` | `.credentials.yaml` + `.env` | **关** ⚠️ | API Key / 账号令牌（设备绑定记录永远不上传） |
| 插件代码 | `node-modules/` | profile 的 `node_modules/` | 关 | 离线可还原，体积大；默认靠恢复时自动 `pnpm install` |
| 附加目录 | `extra-N/` | `include.extraPaths` | 空 | 任意自定义目录 |

**隐私声明**（勾选 ⚠️ 模块时页面会完整展示）：这些文件可能包含 API 密钥或服务器访问令牌。此类内容**不会被上传到任何第三方**——文件在本机读取后整体加密（scrypt 派生密钥），离开设备的只有密文，插件作者与云端存储都无法解密；凭证文件会在本机按规则剔除设备绑定记录后再入包（剔除过程不出本机）。插件本身没有任何遥测或内容上报。

**profile 白名单说明**：DSH 配置档案按白名单只打包上面列出的 6 个文件——插件管理器日志（`.plugin-manager/`）、市场日志（`.dsh-market/log.ndjson`）、`package.json.lock` 等运行产物**不再进入归档**。若未来 DSH 在 profile 根新增配置文件，需同步维护 `lib/collect.js` 的 `PROFILE_FILES`。

**不同步**：会话历史（`sessions/`）、工作区缓存（`storages/session_projcache` 等）、账户计费统计（`.dshw-usage.json`）、设备标识（`.anonymous-user-id`）、模型目录缓存（`.workbuddy-*`、`dsh-moa-catalog.json`）。

---

## 2. 存储目标怎么选

| 方案 | 适合 | 配置难度 | 说明 |
| --- | --- | --- | --- |
| **Cloudflare R2** | 海外/全球 | ★ | S3 兼容，10 GB 免费，无出网流量费；国内访问一般 |
| **Backblaze B2** | 海外/全球 | ★ | S3 兼容，10 GB 免费，便宜 |
| **AWS S3 / Wasabi / iDrive e2 / Scaleway / Hetzner / MinIO** | 各区域 | ★ | 全部走同一个 S3 适配器，填 endpoint/region/bucket/AK/SK 即可 |
| **阿里云 OSS / 腾讯云 COS** | 中国大陆 | ★★ | 兼容 S3 子集，用 AK/SK；bucket 名常带 APPID（COS） |
| **坚果云 WebDAV** | 中国大陆个人 | ★ | `https://dav.jianguoyun.com/dav/` + 应用密码；免费额度小但足够配置 |
| **Nextcloud / Seafile / Synology / pCloud / Yandex Disk / Koofr / kDrive** | 自建或海外 | ★ | 都提供 WebDAV，用应用密码 |
| **本地同步目录** | 所有人 | ★ | 指向 iCloud Drive / OneDrive / 坚果云同步盘 / NAS 挂载目录即可，零密钥 |
| **rclone / OpenList 桥接** | 想用百度网盘、Google Drive、OneDrive、Dropbox、MEGA… | ★★★ | 本机跑 `rclone serve webdav` 或 OpenList，本插件把它当普通 WebDAV；详见 `cloud-backup-comparison.md` |

**推荐组合**：国内用户 = 坚果云 WebDAV（最省事）或阿里云 OSS（最稳）；海外用户 = Cloudflare R2；不想注册任何服务 = 本地同步目录。

更完整的 15 家对象存储、20+ 家网盘 API 对比（含价格、区域、是否需要 OAuth）见 [`cloud-backup-comparison.md`](./cloud-backup-comparison.md)。

> 百度网盘 / 阿里云盘 / 夸克网盘没有可直接使用的通用接口（OAuth + 开发者审核，且限制第三方客户端），v1 不内置；用 OpenList 转 WebDAV 更现实。

---

## 3. 安装

插件目录就是本仓库（`package.json` 声明了 `dsh.bundle.patch`）。

**方式 A：图形界面**
设置 → 插件 → 安装本地插件 → 选择本目录。

**方式 B：让 Agent 安装**
对 Agent 说「把 `C:\...\dsh-sync` 这个目录作为插件装上」，它会调用 `plugin_manager` 的 `install_bundle`。

安装后 Host 侧工具立即生效；设置页是前端模块，**需要重启一次 DSH**（完全退出后重新打开）才会出现。

---

## 4. 使用

### 图形界面：设置 → 同步

重启后打开「设置」，左侧会多出 **同步** 一页。0.4 起页面顶部是**常驻状态条**（已同步/有变更/未配置 + 上次备份概览），下面三个页签：

- **备份**：备份内容模块清单（逐项开关、实时体积）→ 存储目标 → 加密口令 → 自动备份 → 操作。每次操作的结果直接显示在按钮下方，长操作有阶段提示。
- **恢复 / 导入**：云端快照列表（自动加载）→ 预览（可展开全部清单、显示将自动安装的插件包）→ 内联两步确认 → 恢复结果与重启提示。也可从 `.dshsync` 文件/目录导入。
- **高级**：命名配置管理（新建/重命名/删除）、状态详情、数据与日志路径。

普通使用不需要碰命令行或聊天：

1. **备份** 页选目标类型（S3 兼容 / WebDAV / 本地目录），填地址与密钥。已保存的密钥显示为 `••••••••`，点「修改」才会替换。
2. 设加密口令：输入时下方实时勾选规则（≥8 位、大小写、数字、特殊符号仅限 `@ # $ * - _`）。
3. 在**备份内容**里勾选要同步的模块（隐私模块开启时需确认隐私声明）。
4. 需要的话开启「定时自动备份」并设间隔。
5. 点 **测试连接** → **立即备份**。快照文件名为 `快照前缀/snapshots/<机器名>_<UTC时间>_<随机>.dshsync`，同一目标下多台机器也分得清。
6. **恢复**：切到「恢复 / 导入」页签 → 快照列表自动加载 → 选中一份（显示「设备 · 时间 · 大小」，最新带「最新」标记）→ **预览选中的快照** → **确认恢复到本机**（二次确认）→ 重启 DSH。

本地模式不需要额外的”导入”按钮：把另一台机器的 `latest.json` 和 `snapshots` 目录拷进目标目录（即 `…\<前缀>\`）后，快照列表会自动读出。即使没有 `latest.json`，只要 `snapshots` 里有 `.dshsync` 文件也能列出并恢复。

如果手里是压缩包或零散文件：解压后在「从文件导入」区点 **选择文件…**（或 **选择文件夹…**）用系统文件管理器挑出 `.dshsync` 文件／目录，再点 **预览这个文件**；也可以直接把路径粘进输入框。

### 对话与工具

安装后，Agent 会获得 7 个工具：

| 工具 | 作用 |
| --- | --- |
| `sync_status` | 查看当前配置、目标、待同步变更、远端最新快照、定时设置、错误 |
| `sync_configure` | 写入当前配置（目标、口令、同步范围 include、定时、上限） |
| `sync_profile` | 管理命名配置：list / create / select / rename / delete |
| `sync_test` | 连通性自检：写探测对象 → 读回 → 删除 |
| `sync_push` | 立即加密备份（内容未变则跳过） |
| `sync_pull` | 恢复：默认只预览，`dryRun:false` + `confirm:true` 才落盘 |
| `sync_snapshots` | 列出云端快照 |

`include` 的模块键（0.4）：`profile`（必选）、`homePatch`、`skillsDsh`、`skillsAgents`、`uiPrefs`、`skillManager`、`mcpConnector`、`workspaceRoot`、`credentials`、`nodeModules`、`extraPaths`。0.3 的旧键 `skills`/`agentsSkills` 会被自动迁移。

### 典型对话

> 「把 DSH 配置备份到我的 Cloudflare R2，bucket 是 `dsh-config`，AK/SK 是 …，口令用 …，每 30 分钟自动同步一次。」

Agent 会依次调用 `sync_configure` → `sync_test` → `sync_push`。

> 「再建一个叫『公司云』的同步配置，切过去。」

Agent 会调用 `sync_profile`（create/select），之后 `sync_configure` 写入的是「公司云」。

新电脑上：

> 「从 R2 恢复我的 DSH 配置，先给我看会改哪些文件。」

确认后再说「确认恢复」，Agent 会 `sync_pull`（`confirm: true`），然后提示重启 DSH。

### 配置存储与加密

`$DSH_HOME/dsh-sync/config.json` **整份是密文**，只有一个信封：

```json
{ "format": "dsh-sync-config", "version": 2, "cipher": "sm1", "blob": "…" }
```

密钥来源按优先级：

| cipher | 密钥 | 说明 |
| --- | --- | --- |
| `sm1` | 系统密钥（Windows DPAPI / macOS 钥匙串） | 默认。拷走文件、换系统用户都无法解密 |
| `ev1` | 环境变量 `DSH_SYNC_MASTER_KEY` 派生 | 服务器/无桌面环境 |
| `ag1` | 同目录 `secret.key`（0600） | 最后退路，只防误读 |

所以文件里连 bucket、endpoint、AK 都看不到；页面上「加密方式」会显示当前用的是哪一种。想更保险可以在 `sync_configure` 里把 `passphrase` 写成 `env:DSH_SYNC_PASSPHRASE`、密钥写成 `env:NAME`——那样连内存里的配置都不落盘。

旧版（v1）明文配置会在首次加载时自动迁移成 v2 密文。

### 定时同步

`schedule.enabled = true` 后，Host 侧每分钟检查一次当前配置是否到期（默认 30 分钟）；内容哈希与上次一致就不产生新快照，失败会按间隔重试。

---

## 5. 安全模型

- 归档 = `gzip` → **AES-256-CTR** → **HMAC-SHA256**（encrypt-then-MAC），密钥用 **scrypt**（N=32768, r=8, p=1）从你的口令派生，每个归档独立 salt/iv。
- 下载先校验 HMAC 再解密；口令错误或文件被改都会明确报错。
- 云端只看到 `latest.json`（时间、大小、内容哈希）和密文快照；文件名里只有时间戳。
- 本机配置整份加密落盘（`safeStorage` → DPAPI/钥匙串；退回 AES-256-GCM + `secret.key`），状态文件 `0600`；`.credentials.yaml` 里的 **设备绑定记录（浏览器会话、设备 ID）永远不上传**，恢复时也不覆盖本机的这两条。
- 口令规则：≥8 位，含大写、小写、数字，且至少一个 `@ # $ * - _`；只允许这些字符。不符合时页面会指出缺少哪一项，并点名不允许的字符（空格、全角字符等）。
- 建议：口令用 12 位以上、不与其它服务复用；页面或 `env:` 引用均可。

---

## 6. 恢复语义与回滚

1. `sync_pull` 默认 `dryRun`，只返回将新增/覆盖的文件清单。
2. `dryRun:false` 且 `confirm:true` 才写盘；写前把被覆盖的文件复制到 `$DSH_HOME/dsh-sync/backups/<时间戳>/`。
3. **不删除**本机独有的文件；快照里没有的来源（比如本机没配的 `extraPaths`）直接跳过并告警。
4. `profile/` 有变更时返回 `restartRequired: true` —— 重启 DSH 生效。
5. 缺失的插件包：若配置里 `restore.installBundles` 为真（默认），会调用 DSH 自带的 pnpm 在 profile 里 `pnpm install`；失败会告警并保留备份。`link:` / `file:` 安装的本地插件需要你手工重装。

---

## 7. 已知限制（0.4）

- 不备份会话历史；不合并两台机器的并发修改（后写覆盖，靠备份回滚）。
- `node_modules` 默认不同步：registry 插件与本地目录插件靠恢复时自动 `pnpm install` 重装/重链（本地插件源码已在快照内）。
- profile 按白名单备份 6 个文件：DSH 未来在 profile 根新增配置文件时，需要同步维护 `lib/collect.js` 的 `PROFILE_FILES`（恢复端对未知文件只告警不失败，不会丢数据）。
- 归档整体在内存中处理，默认上限 256 MB（`limits.maxArchiveMB`）；开启 `nodeModules` 前请调大并确认内存。
- 配置已整份加密落盘（`safeStorage` / DPAPI，退回 AES-256-GCM + 本地密钥文件）；但同一系统用户下的恶意程序仍能调用系统解密接口，这一点由操作系统决定，插件无法绕过。
- 设置页无自动化测试（保持零构建、零依赖），界面回归依赖手工清单（见 `TESTING-2-MACHINES.md`）。

---

## 8. 开发与测试

纯 ESM、零第三方依赖，只 import `node:*`（`electron` 仅做可选动态导入）；插件跑在 Host 进程里。

```powershell
node --test test/           # 或逐个文件运行，见下
node test/core.test.js      # 归档 / 加密 / SigV4 / 凭证过滤
node test/backends.test.js  # 用本地 HTTP 服务器模拟 S3 与 WebDAV
node test/engine.test.js    # push / status / prune / pull / 模块白名单 / 回滚
node test/config.test.js    # 加密落盘、v1 迁移、命名配置增删改、include 键迁移
node test/api.test.js       # 表单视图、口令规则
node test/api-handler.test.js # 设置页 HTTP 接口（含 modules.preview）
node test/plugin.test.js    # 用假 Cordis Context 跑通 7 个工具
node scripts/live-verify.mjs  # 真机验证（只读真实 ~/.dsh，写入临时目录）
```

目录：

```
index.js              插件入口（apply、定时器、pnpm 调用）
client.js             设置页（状态条 + 备份/恢复/高级三页签）
lib/container.js      归档容器 + 认证加密
lib/collect.js        快照采集（模块清单、profile 白名单、浅遍历试算）
lib/engine.js         push / pull / status / prune
lib/config.js         配置、状态、日志、脱敏
lib/tools.js          6 个 agent 工具
lib/backends/         s3.js / webdav.js / local.js
lib/credentials.js    设备绑定记录的过滤与合并
scripts/live-verify.mjs  真机 round-trip 与旧快照兼容验证
test/                 node:test 用例
```
