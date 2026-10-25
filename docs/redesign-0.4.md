# dsh-sync 0.4 体验重构 · 技术设计文档

- **状态**：待用户确认（§0 的 4 个决策点采用推荐默认值，均标注 ⚠️ 待确认，可推翻）
- **日期**：2026-10-25
- **基线**：仓库 `main@99848d0`（v0.3.6），28 个测试全绿
- **范围**：设置页 UX 重构（任务一）、备份内容模块化（任务二）、三层代码审查（任务三）

---

## 0. 决策点汇总（⚠️ 待确认）

| # | 决策点 | 本文采用的默认方案 | 备选 |
| --- | --- | --- | --- |
| D1 | 首层 review 工具（本机无 superpowers:review） | 开发者按清单做**系统性人工审查**作为第一视角 | comprehensive-code-review 技能 / 改两层 |
| D2 | profile 目录备份粒度 | **核心文件白名单**（§2.2） | 整目录 + 排除清单 |
| D3 | MCP 连接器 `storages/mcp_connector.json` | 纳入为**默认关闭**的可选模块，整文件加密入归档 | 脱敏后入归档 / 不纳入 |
| D4 | 开发期部署方式 | **重装链接到开发目录** `~/Documents/项目开发工程/dsh-sync`（真机可测；桌面旧目录保留不动） | 构建后覆盖桌面目录 / 只跑单测 |

---

## 1. 问题诊断摘要（证据见 2026-10-25 摸底）

### 1.1 UX（任务一）

1. **反馈错位**：全局唯一 `notice` 固定在页面顶部（client.js:483），而"恢复/导入"操作区在底部——底部操作的结果出现在视口外。
2. **备份范围不可见不可选**：后端 `include` 完整支持，但设置页无任何控件。
3. **模块同质化**：8 个卡片同一样式纵向堆叠，"状态"与"恢复"无视觉区分；主操作按钮孤立夹在中间。
4. **无过程反馈**：备份/恢复是数秒到数十秒操作，仅按钮文字变化。
5. **隐性副作用**：测试/备份/预览按钮隐式先保存整个表单。
6. 恢复清单只显示 30 条不可展开；删除配置的确认提示也在视口外。

### 1.2 备份内容（任务二，试采集实测 3960 文件 / 50MB 未压缩）

- **噪声**：`profile/` 134 条中约 125 条是 `.plugin-manager/logs/`、`.dsh-market/log.ndjson`、`package.json.lock`、`discovery-compatibility-v1.json`——插件管理器日志与市场缓存，不应入归档。
- **缺失的用户配置**：`storages/mcp_connector.json`（桌面版 MCP 连接器，README"MCP 都在 cordis.patch.yml"的说法与本机事实不符）、`.dshw-size.json`（界面偏好）、`skills-manager/state.json` 与 `dsh-skill-explorer/provider-toggles.json`（skill 来源开关）、`profiles/package.json`（workspace 根依赖 dshmarket）、`$DSH_HOME/.env`（官方凭证链一环）。
- **确认不备**：`sessions/`、`storages/session_projcache`、`.dshw-usage.json`（账户计费）、`.anonymous-user-id`（设备标识）、`.workbuddy-*`、`dsh-moa-catalog.json`（模型缓存）、`logs/`。
- **符号链接**：`~/.agents/skills` → `~/.mirasim/skills`，采集跟随链接（3990 条，占体积 99%），行为正确，保持。
- **官方机制**（deepseek-ai/deepseek-harness apps/cli）：配置树 = bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`；凭证链 = env → `$DSH_HOME/.credentials.yaml` → 调用目录 `.env` → `$DSH_HOME/.env`；`desktop` 为 Electron 保留 profile。

---

## 2. 备份内容模块化设计（任务二，后端先行）

### 2.1 模块清单与默认值（`include` v0.4）

| 模块 id | 归档前缀 | 本机来源 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `profile` | `profile/` | `profiles/<name>/` 白名单文件 | **开（必备，不可关）** | §2.2 |
| `homePatch` | `home/` | `$DSH_HOME/cordis.patch.yml` | 开 | 机器级 patch |
| `skillsDsh` | `skills-dsh/` | `$DSH_HOME/skills/` | 开 | DSH 自建 skill（目录不存在时静默跳过，现有行为） |
| `skillsAgents` | `skills-agents/` | `~/.agents/skills/` | 开 | 跨工具 skill（跟随符号链接） |
| `uiPrefs` | `ui/` | `$DSH_HOME/.dshw-size.json` | 开 | 桌面界面偏好（缩放/音效/气泡） |
| `skillManager` | `skill-manager/` | `skills-manager/state.json`、`dsh-skill-explorer/provider-toggles.json` | 开 | skill 来源开关与禁用列表 |
| `mcpConnector` | `mcp/` | `storages/mcp_connector.json` | **关** ⚠️D3 | 桌面版 MCP 连接器（含 grants，可能有令牌；归档有口令加密保护） |
| `workspaceRoot` | `workspace-root/` | `profiles/package.json` | **关** | workspace 根依赖（dshmarket）；DSH 是否自动重建待真机验证 |
| `credentials` | `credentials/` | `$DSH_HOME/.credentials.yaml` + `$DSH_HOME/.env` | **关** | API Key/令牌；`.env` 为新增来源；设备绑定记录照旧过滤 |
| `nodeModules` | `profile/node_modules/` | profile 内 | **关** | 现有行为不变 |
| `extraPaths` | `extra-N/` | 用户自定义 | 空 | 现有行为不变 |

**兼容性**：旧字段 `include.skills` → `skillsDsh`、`include.agentsSkills` → `skillsAgents` 在 `completeProfile` 里迁移（读旧写新，一次性）；归档头的 `roots` 本就数据驱动，旧快照在新版本恢复不受影响（未启用模块的条目走现有的"unmapped 跳过 + 告警"路径）。

### 2.2 profile 白名单（⚠️D2）

`profile/` root 从 `type: 'dir'`（整目录遍历）改为 `type: 'files'`（精确清单）：

```
package.json            插件清单（dsh.profile.bundles + link 依赖）
cordis.patch.yml        所有插件配置、模型/界面偏好（核心）
cordis.yml              入口声明（4 行）
pnpm-workspace.yaml     allowBuilds 等构建白名单（影响 pnpm install 成败）
pnpm-lock.yaml          版本锁定
.dsh-market/state.json  市场设置（区域/侧栏）
```

排除即显式不入归档：`.plugin-manager/`、`.dsh-market/log.ndjson`、`.dsh-market/discovery-compatibility-v1.json`、`package.json.lock`、`node_modules/`（除非 nodeModules 开）。
维护约定：DSH 未来在 profile 根新增配置文件时需同步此白名单——在 README「已知限制」注明。

### 2.3 采集实现改动（`lib/collect.js`）

- `buildRoots` 按上表生成 roots；`RootSpec` 增加 `defaults: boolean`（恢复时 UI 提示"快照包含但本机未启用"）。
- `type: 'files'` 的 root 支持子目录相对路径（`.dsh-market/state.json`、`skills-manager/state.json`、`dsh-skill-explorer/provider-toggles.json`），归档内路径 = `<id>/<相对路径>`。
- `credentials` root 的 `names` 扩为 `['.credentials.yaml', '.env']`，`.env` 同样经 `stripDeviceRecords`（对无 records: 结构的纯 KV 文本原样保留——`.env` 不含设备绑定记录，直接透传）。
- 采集统计 `stats.roots` 增加 `optional` 标记，供前端显示模块开关的实时条数/体积（status 端点已有 `local.roots`，前端未用，本次接上）。

### 2.4 恢复语义（每模块）

| 模块 | 恢复动作 |
| --- | --- |
| profile | 现有逻辑：覆盖 + `mergePackageJson`（保留本机可用 link 依赖）+ pnpm install |
| homePatch / uiPrefs / skillManager / workspaceRoot / mcpConnector | 整文件覆盖（写前备份到 `backups/<stamp>/`）；mcpConnector 覆盖前提示"将替换本机全部 MCP 连接器配置" |
| skillsDsh / skillsAgents / extraPaths | 现有目录合并语义（不删本机独有文件） |
| credentials | 现有 `mergeCredentialRecords`（保设备绑定） |

### 2.5 测试计划（`test/`）

- collect：白名单只打包 6 个文件；`.env` 入 credentials；模块开关逐一生效；旧 `include.skills` 字段迁移。
- engine：含新模块的快照 round-trip；未启用模块的恢复跳过与告警；mcpConnector 覆盖前备份存在。
- config：`completeProfile` 对 v0.3 配置文件补全新默认值。

---

## 3. 设置页 UX 重构设计（任务一）

### 3.1 信息架构：常驻状态条 + 三页签

```
┌────────────────────────────────────────────────────────────┐
│ DSH 同步                                        [配置 ▾][⚙] │
│ ● 已同步 · 上次备份 10-25 20:09 · 3,960 文件 · R2 · 下次 30 分钟│  ← 常驻状态条
├────────────────────────────────────────────────────────────┤
│  备份      恢复      高级                                     │  ← 页签
├────────────────────────────────────────────────────────────┤
```

- **状态条**（一眼可判断"现在什么状态"）：同步状态点（已同步/有变更/未配置/出错）· 上次备份 · 文件数与体积 · 目标 · 定时。点状态点滚动到详情。
- **备份页**：备份内容模块清单（每行：开关 + 名称 + 实时文件数/体积 + ⓘ说明）→ 存储目标（S3/WebDAV/本地 分段选择 + 字段）→ 加密口令 → 定时备份 → 主操作区（保存 / 测试连接 / 立即备份）。
- **恢复页**：云端快照列表（含本机与其他设备，选中即预览对象）→ 或从文件/目录导入 → 预览清单（可展开全部）→ 确认恢复（两步确认内联）→ 恢复结果与重启提示。
- **高级页**：命名配置管理（新建/重命名/删除，移出主视野）· 加密方式说明 · 限额（maxFileMB/maxArchiveMB/maxFiles）· 数据目录路径 · 日志位置。

### 3.2 关键交互改动

1. **反馈就地化**：每个操作按钮正下方渲染结果块（成功绿/警告黄/错误红 + 具体数字）；同时保留顶部轻量 toast（5 秒自动消失）双通道。**消灭"结果在视口外"。**
2. **过程反馈**：长操作（备份/恢复/测试）在按钮区显示阶段文案（"正在采集文件 → 打包加密 → 上传 8.4MB…"，按引擎实际阶段推进）+ 转圈。不做百分比（单请求 HTTP 无真实进度，避免过度设计）。
3. **显式保存**：移除"测试/备份/预览隐式保存"。表单有未保存改动时，主操作区出现提示条"有未保存的修改 [保存并继续] [放弃]"；保存按钮独立。
4. **恢复两步确认内联**：预览清单下方直接放"确认恢复到本机"（红色、需点击展开二次确认文字），不再跨卡片。
5. **快照列表默认自动加载**（进入恢复页即刷新，不强制手点"刷新列表"）；本地模式空态给出复制路径的一键复制。
6. **模块清单联动**：勾选/取消模块即时重算体积与文件数（调 status）；口令、目标未配置时状态条直接显示缺口并链到对应页签。
7. 删除配置移入高级页，确认采用内联二次点击（现状保留但不再依赖顶部 notice）。

### 3.3 组件结构（client.js 拆分，仍单文件零构建）

```
client.js
├─ 基础件   Field/Text/Button/Row/Secret/Info（现有，微调）
├─ StatusHeader      常驻状态条
├─ BackupTab         ModuleList + TargetForm + PassphraseField + ScheduleField + 主操作区
├─ RestoreTab        SnapshotList + FileImport + PreviewPanel + ConfirmBar
├─ AdvancedTab       ProfileManager + LimitsForm + EnvInfo
├─ Feedback          就地结果块（props: tone/text/detail）
└─ SyncSettings      状态容器（数据获取/保存/页签切换/长操作编排）
```

CSS 延续现有 `dshsync-*` 命名与 DSH 主题变量（`--dsw-alias-*`），新增页签、状态条、模块行样式。

### 3.4 API 改动（`lib/api.js`）

| 端点 | 改动 |
| --- | --- |
| `status` | 返回值已含 `local.roots`（含每模块条数）——补充各模块 `present`（本机是否存在）供 UI 灰显 |
| `config.save` | 支持新 `include` 结构（后端 §2 已保证兼容） |
| `push` / `pull` / `pull.file` | 不变（前端负责阶段文案） |
| 新增 `modules.preview` | 轻量：按当前表单的 include 试算各模块文件数/体积（复用 `buildRoots` + 浅遍历，不读文件内容、不算哈希，避免整包计算卡顿） |

### 3.5 测试计划

- api.test：`modules.preview` 返回结构；`status.roots` 含 present。
- api-handler.test：新端点走假 HTTP 驱动。
- 前端无自动化测试基建（现状零构建、无 vitest）——以真机走查 + `TESTING-2-MACHINES.md` 更新后的手工清单验证；不为前端引入构建工具链（最小修改原则，如需后续单独立项）。

---

## 4. 开发任务编排

| # | 任务 | 依赖 | 产出与验收 | 预估 |
| --- | --- | --- | --- | --- |
| T1 | 备份模块化后端：collect.js roots 白名单 + config.js 默认值与字段迁移 + credentials .env | — | `node --test` 全绿（新增 §2.5 用例）；试采集 profile/ 恰为 6 文件 | 0.5 天 |
| T2 | API 扩展：`modules.preview` 端点 + status.roots.present | T1 | api 测试绿 | 0.25 天 |
| T3 | 前端重构：组件拆分 + 三页签 IA + 就地反馈 + 模块清单 UI + 显式保存 + 恢复内联确认 | T2 | 真机（⚠️D4 链接开发目录）走查 §3.2 全部 7 项 | 1.5 天 |
| T4 | 真机验证：本机备份→恢复 round-trip + 旧快照（trash/ 内 0.3.4 快照）兼容恢复 | T3 | 双机流程文档手工清单全过 | 0.5 天 |
| T5 | 文档更新：README（模块表/白名单/已知限制）、TESTING-2-MACHINES.md、locale | T3 | 与实现一致 | 0.25 天 |
| T6 | 三层 review 与修复（§5） | T1–T5 | 三份 review 报告 + 问题闭环 | 1 天 |
| T7 | 发布 0.4.0：版本号、CHANGELOG 段落、git 提交与打 tag | T6 | `node --test` 全绿 + 用户验收 | 0.25 天 |

每个任务完成即 git 提交（含详细版本说明，遵循用户开发习惯）。

---

## 5. 三层代码审查流程（任务三，⚠️D1）

编码完成且 `node --test` 全绿后：

1. **第一层 · 系统性人工审查**（本默认方案）：逐文件按清单审查——安全（路径穿越/密钥泄漏/注入）、并发与竞态（定时器与手动 push 重入、原子写）、边界（空值/超大文件/符号链接循环）、错误处理（网络失败半程状态）、兼容（旧配置/旧快照/跨平台路径）、最小修改原则符合度。产出 `review-report-1.md`。
2. **第二层 · code-review-skill**：以该技能的规范清单再审一遍，产出 `review-report-2.md`。
3. **第三层 · open-code-review（ocr）**：对整个开发分支 diff 做 AI review，产出 `review-report-3.md`。

每层：问题分级（P0 必修 / P1 应修 / P2 建议）→ 修复 → 复测 `node --test` → 在报告中标注闭环。三层视角互补：第一层重逻辑与项目语义，第二层重语言/框架规范，第三层重 diff 级回归风险。

---

## 6. 风险与对策

| 风险 | 对策 |
| --- | --- |
| DSH 升级在 profile 根新增配置文件，白名单漏备 | README 已知限制注明；恢复端对缺失文件只告警不失败；快照头 `roots` 保留完整来源信息便于排查 |
| `mcp_connector.json` 含活动令牌，泄露面扩大 | 默认关闭；开启时 UI 明示含令牌；归档口令加密 + 本机配置密文落盘双层保护 |
| `profiles/package.json` 恢复可能与 DSH 自身管理冲突 | 默认关闭；恢复时若文件已存在且内容不同 → 覆盖前备份（统一语义） |
| 前端无自动化测试，回归靠走查 | T4 手工清单固化到 TESTING-2-MACHINES.md；组件拆分降低耦合面 |
| 定时器在模块化后采集变快，触发频率不变 | 无影响（间隔逻辑未动）；采集白名单后 status 反而更轻 |
| 0.3.x 旧快照在 0.4 恢复 | roots 数据驱动机制不变；T4 用 trash/ 内真实 0.3.4 快照验证 |

---

## 7. 版本与发布

- 版本 `0.4.0`（含配置结构扩展与 UI 重构，minor 提升）；归档格式保持 `dsh-sync/2` 不变。
- 提交策略：T1–T7 每任务一提交；最终 tag `v0.4.0`。
- README「已知限制」更新：白名单维护约定、前端无自动化测试说明。
