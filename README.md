# DSH Sync · DSH 配置同步插件

把一整台机器上的 DSH「个人状态」加密备份到云端，换电脑后一条命令还原：插件、插件设置、模型与界面偏好、MCP 服务器、自建 skill、API Key，全都在里面。

- **一个归档**：所有配置打包成一个加密文件，云端只看到密文。
- **三种目标**：S3 兼容对象存储、WebDAV、本地同步目录（iCloud/OneDrive/坚果云/NAS）。
- **定时同步**：按分钟级间隔自动备份，内容没变就不上传。
- **可回滚**：恢复前自动备份本机文件，从不删除本机独有的文件。

---

## 1. 它同步什么

| 归档前缀 | 本机来源 | 内容 |
| --- | --- | --- |
| `profile/` | `$DSH_HOME/profiles/<profile>/` | `package.json`（已安装 bundle 清单）、`cordis.patch.yml`（**所有插件配置、MCP 服务器、模型/界面偏好**）、`cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` |
| `home/` | `$DSH_HOME/cordis.patch.yml` | 用户级 patch（若存在） |
| `skills-dsh/` | `$DSH_HOME/skills/` | 自建 skill |
| `skills-agents/` | `~/.agents/skills/` | 跨工具共享 skill |
| `credentials/` | `$DSH_HOME/.credentials.yaml` | API Key / 账号令牌（**默认关闭**；设备绑定记录永远不上传） |
| `extra-N/` | 自定义 | `include.extraPaths` 里的任意目录 |
| `profile/node_modules/` | 同 profile | 默认关闭；开启后连插件代码一起备份（离线可还原，体积大） |

**不同步**：会话历史（`sessions/`）、工作区缓存（`storages/`）、`node_modules`（除非显式开启）。

MCP 服务器写在 `cordis.patch.yml` 里，所以「MCP 配置」不需要单独处理。

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

重启后打开「设置」，左侧会多出 **同步** 一页，普通使用不需要碰命令行或聊天：

1. **同步配置**：下拉选择已有配置，或「新建」一个（例如「家里的 R2」「公司坚果云」）。每个名字对应一个目标 + 一套口令；「重命名」「删除」就地完成，删除不影响云端快照。
2. 选「S3 兼容 / WebDAV / 本地目录」，填地址与密钥。已保存的密钥显示为 `••••••••`，点「修改」才会替换。
3. 设加密口令：输入框为空时提示「请输入口令」，右侧 ⓘ 悬停显示完整规则；输入过程中下方实时勾选规则（≥8 位、大小写、数字、特殊符号仅限 `@ # $ * - _`）。保存后显示 8 个圆点，不再与空输入混淆。
4. 需要的话勾选「定时自动备份这个配置」并设间隔。
5. 点 **测试连接** → **立即备份**。快照文件名为 `快照前缀/snapshots/<机器名>_<UTC时间>_<随机>.dshsync`，同一目标下多台机器也分得清。
6. **恢复 / 导入（本地、云端同一套流程）**：
   1. 点卡片里的 **刷新列表**，读出目标位置的全部快照；
   2. 在下拉里选要恢复的那份（显示「设备 · 时间 · 大小」，最新那份带「最新」标记）；
   3. **预览要恢复的内容** → 看清单 → **确认恢复到本机** → 重启 DSH。

本地模式不需要额外的“导入”按钮：把另一台机器的 `latest.json` 和 `snapshots` 目录拷进目标目录（即 `…\<前缀>\`）后点「刷新列表」，选中那台机器的快照即可。即使没有 `latest.json`，只要 `snapshots` 里有 `.dshsync` 文件也能列出并恢复。

如果手里是压缩包或零散文件：解压后在「恢复 / 导入」里点 **选择文件…**（或 **选择文件夹…**）用系统文件管理器挑出 `.dshsync` 文件／目录，再点「预览这个文件」；也可以直接把路径粘进输入框。不需要先把文件摆成目标目录结构。

页面底部显示当前配置名、本地变更、最近备份、目标最新快照和待完善项；恢复会先备份被覆盖的文件，不会删除本机独有文件。

### 对话与工具

安装后，Agent 会获得 7 个工具：

| 工具 | 作用 |
| --- | --- |
| `sync_status` | 查看当前配置、目标、待同步变更、远端最新快照、定时设置、错误 |
| `sync_configure` | 写入当前配置（目标、口令、同步范围、定时、上限） |
| `sync_profile` | 管理命名配置：list / create / select / rename / delete |
| `sync_test` | 连通性自检：写探测对象 → 读回 → 删除 |
| `sync_push` | 立即加密备份（内容未变则跳过） |
| `sync_pull` | 恢复：默认只预览，`dryRun:false` + `confirm:true` 才落盘 |
| `sync_snapshots` | 列出云端快照 |

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

## 7. 已知限制（v1）

- 不备份会话历史；不合并两台机器的并发修改（后写覆盖，靠备份回滚）。
- `node_modules` 默认不同步：registry 插件靠 `pnpm install` 重装，本地链接插件需手工处理。
- 归档整体在内存中处理，默认上限 256 MB（`limits.maxArchiveMB`）；开启 `nodeModules` 前请调大并确认内存。
- 配置已整份加密落盘（`safeStorage` / DPAPI，退回 AES-256-GCM + 本地密钥文件）；但同一系统用户下的恶意程序仍能调用系统解密接口，这一点由操作系统决定，插件无法绕过。

---

## 8. 开发与测试

纯 ESM、零第三方依赖，只 import `node:*`（`electron` 仅做可选动态导入）；插件跑在 Host 进程里。

```powershell
node --test test/           # 或逐个文件运行，见下
node test/core.test.js      # 归档 / 加密 / SigV4 / 凭证过滤
node test/backends.test.js  # 用本地 HTTP 服务器模拟 S3 与 WebDAV
node test/engine.test.js    # push / status / prune / pull / 回滚
node test/config.test.js    # 加密落盘、v1 迁移、命名配置增删改
node test/api.test.js       # 表单视图、口令规则
node test/api-handler.test.js # 设置页 HTTP 接口
node test/plugin.test.js    # 用假 Cordis Context 跑通 7 个工具
```

目录：

```
index.js              插件入口（apply、定时器、pnpm 调用）
lib/container.js      归档容器 + 认证加密
lib/collect.js        快照采集（哪些目录、哪些排除）
lib/engine.js         push / pull / status / prune
lib/config.js         配置、状态、日志、脱敏
lib/tools.js          6 个 agent 工具
lib/backends/         s3.js / webdav.js / local.js
lib/credentials.js    设备绑定记录的过滤与合并
test/                 node:test 用例
```
