# dsh-sync 0.4 体验重构 · 第一层系统性审查报告（review-report-1）

- **审查人**：首席软件架构师（第一层 · 系统性人工审查，对应设计文档 §5/D1）
- **日期**：2026-10-25
- **审查范围**：`git diff 99848d0..HEAD`（T1–T5 全部 7 个提交），基线 `main@99848d0`（v0.3.6）
- **方法**：逐文件通读 diff 与全文（lib/collect.js、lib/config.js、lib/engine.js、lib/api.js、client.js、test/、scripts/live-verify.mjs、README、TESTING-2-MACHINES.md），对照 `docs/redesign-0.4.md` §0 决策 / §2 备份模块化 / §3 UX 重构逐条核验；本地实跑 `node --test`（**32/32 全绿**）；对可疑边界（include.profile=false、旧键迁移、stripDeviceRecords 对 .env 的透传）做了运行时验证。
- **分级**：P0 必修（Critical）/ P1 应修（Important）/ P2 建议（Minor），与设计文档 §5 的三层流程约定一致。

---

## 已确认做得好的地方（Strengths）

1. **模块元数据单一来源**：`SYNC_MODULES`（lib/collect.js:37-48）一张表同时供 `buildRoots`、`previewModules`、前端模块清单消费，label/hint/默认值/敏感标记不会漂移。`moduleLabelOfPrefix` 让恢复端告警能翻译成模块名，闭环干净。
2. **恢复端白名单匹配实现正确**：`names.includes(rel.join('/'))`（lib/engine.js:353）正确支持子目录相对路径（`.dsh-market/state.json` 等），且原有的 `assertSafeArchivePath` + `path.relative` 越界双重防护完整保留。
3. **迁移位置与理由都对了**：`migrateIncludeKeys` 放在 `deepMerge` 之前（lib/config.js:99），注释写明了"为什么必须在 merge 前"（merge 会用默认值填新键，之后无法区分用户显式设置）。v0.3 的 `skills:false` 等用户选择被保留，有专项测试（test/config.test.js 新增用例）。运行时验证了全部三个调用点（loadDocument 解密文档、migrateV1、createProfile 的 structuredClone）中原地修改 raw.include 均无别名副作用。
4. **D3 隐私模块落地完整**：mcpConnector/credentials 默认关、UI 内联声明 + ⓘ 常驻全文、`PRIVACY_NOTICE` 措辞与设计一致（不读取/不解析/不上传 + 口令加密）；`.env` 经 `stripDeviceRecords` 处理，已验证对无 `records:` 结构的纯 KV 文本原样透传（lib/credentials.js:45-50），与设计 §2.3 的描述吻合。
5. **旧快照兼容主路径扎实**：unmapped 告警从 0.3 的笼统计数升级为按模块名点名（lib/engine.js:392-395）；0.3 快照的白名单核心文件、`home/`、`skills-dsh/`、`skills-agents/`、`credentials/.credentials.yaml` 前缀全部未变，可正常映射。单测 + live-verify（手工构造 0.3.4 结构快照）双重覆盖。
6. **真机验证脚本的安全设计**：live-verify.mjs 只读真实 `~/.dsh/profiles/desktop`，全部写入落在临时目录（覆盖 `paths`/`store` 的手法干净），含 push→dryRun→confirm round-trip 与旧快照兼容两条链路。
7. **最小修改原则执行到位**：index.js、container.js、backends/、secrets.js、http.js、picker.js 等 9 个文件零改动；新增注释全部为简体中文；纯 ESM、仅 `node:*` 导入的约束未破坏。
8. **前端闭包纪律良好**：`formRef` 规避了 `applyModuleToggle` 里的过期 form；`run()` 的 `promise.catch().finally()` 链（client.js:348-353）吞掉 rejection 后不会再产生 unhandled rejection；`onToggleModule` 每次渲染重建、闭包新鲜，审查重点担心的 privacyAck 过期问题实际不存在。
9. **反馈就地化主体达成**：Feedback 按 action 键隔离渲染在按钮下方（save/test/push/preview/previewFile/apply/snapshots/naming/delete 各自独立），Progress 阶段提示、恢复两步内联确认、隐私二次确认、删除内联二次点击均已实现。
10. **测试质量总体好**：白名单测试逐项断言 6 文件入包 + 4 类噪声排除；模块开关测试覆盖敏感模块默认关/开启后入包/关闭后恢复跳过并按模块名告警；api-handler 层的 `modules.preview` 用例同时验证了 include override 的 enabled 语义。

---

## 问题清单（Issues）

### Critical（P0 必修）

无。核心链路（模块化采集、配置迁移、旧快照恢复、加密往返）未发现必须立即修复的缺陷。

### Important（P1 应修）

**P1-1 手动编辑文件路径后，确认恢复写入的不是预览过的文件**
- 位置：client.js:856-858（`从文件导入` 的 Text `onChange: (v) => setFilePath(v)`）与 client.js:466-469（onApply 用**当前** `filePath` 发起 `pull.file`）
- 问题：`选择文件…`/`选择文件夹…` 按钮选中后会 `setPlan(null)`（client.js:440），但**手动在输入框改路径**不会清空已预览的 plan 和 confirmRestore 状态。用户预览了文件 A → 把路径改成 B → 点「确认：覆盖这些文件」，实际恢复的是 B，而确认框声称覆盖"上表列出的本机文件"（A 的清单）。快照下拉框的 onChange 已做了 `setPlan(null)`（client.js:825），两处行为不一致。
- 为什么重要：这是唯一一个"明示给用户的清单与实际落盘内容可能不符"的入口；恢复是覆盖性危险操作，一致性被打破会直接破坏对两步确认的信任。
- 怎么修：`filePath` 的 onChange 中追加 `setPlan(null); setConfirmRestore(false);`（与快照下拉对齐）；或 onApply 前校验 `filePath` 与预览时的值一致，不一致则要求重新预览。

**P1-2 §3.2-3「显式保存」未按设计实现：测试/备份仍隐式保存**
- 位置：client.js:376-377（onTest 的 task 首行 `await save()`）、client.js:387-388（onPush 同）；提示条 client.js:781
- 问题：设计文档 §3.2 第 3 项明确"移除'测试/备份/预览隐式保存'，提示条为'有未保存的修改 [保存并继续] [放弃]'"。实现保留了 `await save()` 的隐式保存，只把提示条文案改为"测试连接 / 立即备份会先保存这些修改"（单行文案，无两个按钮）。恢复预览（onPreview/onPreviewFile）确实不再隐式保存，与设计一致。
- 为什么重要：这是设计文档与实现的直接矛盾，不是细节走样——隐式保存意味着"只想测试连接"的用户会把半成品目标配置永久写入加密配置文件。当前实现用提示条如实告知，可辩护，但**必须由用户（设计者）裁定接受偏差并回写设计文档，而不是让文档与代码静默分叉**。
- 怎么修（二选一）：(a) 按设计移除 `await save()`，dirty 时禁用测试/备份并展示 [保存并继续][放弃]；(b) 保留现状，在 `docs/redesign-0.4.md` §3.2-3 补记偏差决策及理由。

**P1-3 恢复预览不显示插件安装计划（§3.2-8），且 README 与实现互相矛盾**
- 位置：lib/engine.js:411-414（`if (dryRun) return summary;` 在前，`bundleDelta(entries)` 在后）→ dryRun 响应没有 `bundles`；client.js:878（`plan.dryRun === false` 才渲染 bundles 行）→ 只在恢复完成后显示"已自动安装 N 个插件包"；README.md:81 却写着"预览（可展开全部清单、**显示将自动安装的插件包**）"
- 问题：设计 §3.2-8 要求预览面板列出 `bundleDelta.missing` 的插件名与版本 spec、标注"恢复后将自动执行 pnpm 安装"。现状是后端在 dryRun 提前返回后才计算 bundleDelta，前端也只在事后显示，形成三方（设计/代码/文档）各说各话。D2 决策里"T3 中把'将自动安装 N 个插件包'显示在恢复预览"是明确承诺。
- 为什么重要：安装计划影响用户对恢复后果的判断（pnpm install 会改 profile），事后才告知削弱了预览的意义；文档承诺了不存在的行为，T5 验收（"与实现一致"）实际未达成。
- 怎么修：把 `const bundleInfo = await this.bundleDelta(entries)` 移到 `if (dryRun) return summary;` 之前，dryRun 的 `summary` 附 `bundles: bundleInfo`（不执行安装）；client.js:878 的条件放宽为 `plan.bundles?.missing?.length > 0`，dryRun 时文案为"恢复后将自动安装 N 个插件包（…）"。README 该句随之成立。

**P1-4 0.3 开启过 nodeModules 的旧快照，其 node_modules 在 0.4 无法恢复，且告警模块名误导**
- 位置：lib/engine.js:353（files/dir 匹配按本机 roots）；0.3 基线 collect.js 的 profile root 是整目录（`profile/node_modules/**` 直接入包），0.4 改为独立前缀 `node-modules/`（lib/collect.js:178-179）
- 问题：0.3 快照里的 `profile/node_modules/left-pad/index.js` 在 0.4 恢复时 rel 不在白名单 → unmapped 跳过；告警把所有 `profile/` 前缀的跳过统一归名为"DSH 配置档案"（lib/engine.js:393），用户会误以为核心配置文件被跳过。设计 §2.1 声称"旧快照在新版本恢复不受影响"、§6 只列了噪声跳过，未预见这一前缀迁移。
- 为什么重要：影响面有限（nodeModules 默认关；registry 插件有自动 pnpm install 兜底；有告警不静默），但**离线恢复场景失效**且与设计文档的兼容性声明不符；告警归名还会引起误判。
- 怎么修（至少做其一）：(a) 恢复端特判：当本机 `include.nodeModules === true` 时，把 `profile/node_modules/` 前缀的条目映射到 `node-modules` root（target = profileDir/node_modules/rel）；(b) 在 README「已知限制」与 §6 风险表注明该例外；(c) unmapped 告警对 `profile/node_modules/` 子前缀单独归名（如"插件代码（node_modules）"），避免归入"DSH 配置档案"。

**P1-5 前端每次勾选模块触发的 `modules.preview` 是无效请求，统计口径也与设计不符**
- 位置：lib/collect.js:77-78（previewModules 用 `allOn` 强制全模块统计，结果与传入 include 几乎无关——只影响 extraPaths 与 enabled 字段）；client.js:411-416（`applyModuleToggle` 每次勾选都 `void loadModules(include)`）；前端未使用后端返回的 `enabled`（client.js:662 自算 checked）
- 问题：设计 §3.4 说 modules.preview"按当前表单的 include 试算"，§3.2-6 说"勾选/取消模块即时重算体积与文件数"。实现把 include 覆盖为全开再统计：勾选触发的重算结果与勾选前完全相同，纯属重复的全树遍历（含默认关闭的 node_modules 与 extraPaths，每次打开设置页和每次勾选都要 readdir+stat 数千条目）。
- 为什么重要：违背设计声明的"轻量"意图（注释里的"浅遍历"实为全树遍历，见 P2-2），并引入无意义网络/IO 往返；快速连续勾选还会产生并发响应乱序（结果相同，无实际危害，但属于侥幸）。
- 怎么修：前端只在初次加载、extraPaths 变化与保存后调用 preview，勾选只改本地状态（数据本来就不变）；或后端按 include 过滤统计范围并让前端真正消费 `enabled`。两者取一即可，推荐前者（改动最小）。

### Minor（P2 建议）

**P2-1** lib/collect.js:91 `stat.present = false;` 是死代码（初始值已是 false，疑似本想写 `true` 表示"来源存在"）。删除或改为正确语义。

**P2-2** lib/collect.js:71 注释与 engine.js:103 称"浅遍历"，`walkTree`（lib/util.js:114-152）实为全树递归 readdir+stat（只是不读文件内容、不算哈希）。建议改称"stat-only 全量遍历"，避免后续维护者低估成本。

**P2-3** preview 的数字与实际备份可能不一致：preview 不施加 `maxFileMB`/`maxFiles`/`maxArchiveMB`（lib/collect.js:75-131），超过 16MB 的文件计入 preview 体积却被真实采集跳过（lib/collect.js:239-241、286-289），超 `maxFiles` 后真实采集截断而 preview 全算。UI 显示的"体积/文件数"可能虚高。建议 preview 至少跳过 >maxFileMB 的文件并在响应里注明口径。

**P2-4** client.js:419、449 的 `stageText`（"正在读取快照并比对本机…"）无处渲染：Progress 只在备份操作区（client.js:790，限 save/test/push）和 plan 卡内 `busy === 'apply'`（client.js:908）渲染；预览这种秒级长操作只剩按钮文字"读取中…"。在恢复页两个预览按钮下方补 `h(Progress, { stage: (busy === 'preview' || busy === 'previewFile') ? stage : '' })`。

**P2-5** client.js:887"展开全部 N 条"受后端 `sample.slice(0, 50)` 上限（lib/engine.js:408）约束，改动超过 50 条时清单并不"全部"。0.3 的 30 条已是改善，但未达设计 §3.2"可展开全部"。建议后端 sample 上限提高到 `plan.length`（dryRun 无写盘风险）或文案改为"展开前 50 条"。

**P2-6** 状态条与 §3.1 规格仍有差距：未显示文件数与目标类型（R2/WebDAV/本地），状态点无"点击滚动到详情"（client.js:619-631，详情在高级页需要切页签而非滚动）。至少给状态点加 onClick → setTab('advanced')。

**P2-7** §3.2-5 的"本地模式空态一键复制路径"未实现：client.js:812-813 只有一段文案。补一个复制按钮（navigator.clipboard.writeText(target.path)）。

**P2-8** client.js:220-227 `setNotice` 返回清理函数但全部调用方（事件回调与 useEffect:290）均未使用，timer 从不清理。React 18 下卸载后 setState 是 no-op、5 秒后 timer 自然释放，无实际泄漏，但这个"仿 effect 返回清理函数"的接口形态会误导后来者。要么在 mount effect 里真正接住清理函数，要么去掉返回值。

**P2-9** `hydrate`（client.js:231-256）不重置 `feedback`/`privacyAck`/`showAllPlan`：切换配置后，上一个配置的"已保存到配置「A」"等反馈与隐私确认状态仍挂在界面上。在 hydrate 里一并 `setFeedback({})`、`setPrivacyAck({})`、`setShowAllPlan(false)`。

**P2-10** client.js:891-892 两行 warnings 渲染条件互补重复（`dryRun === false` 与 `!== false` 各写一遍、内容相同），可合并为一行。

**P2-11** client.js:527-541 删除配置的二次确认没有取消路径也没有超时重置：点过一次"删除"后按钮永久停留在"确认删除"态（直到 hydrate）。补一个"取消"或 5 秒后自动复位。

**P2-12** lib/config.js:88-93 迁移条件是"`skillsDsh` 未定义才迁移"：对话工具 `sync_configure` 在 0.4 配置上补传旧键 `skills: true` 时，因 `skillsDsh` 已有默认值，旧键会在保存时被静默删除、用户设置丢失。与 lib/tools.js:56 "Legacy keys skills/agentsSkills are migrated automatically" 的描述不符。改法：updateProfile 的 mutate 前对 patch.include 也跑一次迁移，或把 tools 描述改为"旧键仅在尚未设置新键时迁移"。

**P2-13** lib/collect.js:125 与 :144 语义缝隙：`include.profile === false` 时 buildRoots 会真的排除 profile（UI 正常操作不可达，但手改配置/对话工具可达），而 preview 仍显示 enabled=true。低风险，建议 buildRoots 对 required 模块忽略 false，或在 preview 的 enabled 计算里尊重 false。

**P2-14** lib/engine.js:443-455 权限策略不一致：`credentials/.env` 强制 0o600，而同为令牌载体的 `mcp/mcp_connector.json` 恢复时用 `entry.mode`（通常 0o644）。建议敏感 root（`sensitive: true`）统一 0o600。

**P2-15** scripts/live-verify.mjs:33 用临时目录当 dshHome，导致 home/skills/ui/skill-manager 模块的真机数据没有参与验证，与文件头"从真实 ~/.dsh 采集（白名单 + 默认模块）"的注释不符（roots 输出里会是一串 ✗）。读取是无害的，可让 dshHome 指向真实 `~/.dsh` 并保持 paths 覆盖不变。另外 :109 的 `.replace(/home$/, …)` 无效（路径以 cordis.patch.yml 结尾，正则永不匹配；断言结论侥幸正确），`readFile(...).catch(() => null)` 会把非 ENOENT 错误也吞成 null——两处建议顺手修正。

**P2-16** 测试缺口（对照设计 §2.5/§3.5）：homePatch/workspaceRoot/nodeModules 的开关切换没有逐一生效的用例（现有模块测试只覆盖 skillsDsh/skillsAgents/mcpConnector/credentials）；§3.5 计划的"status.roots 含 present"断言未写；test/engine.test.js:131 `assert.ok(!X.includes('browser-local') || X.includes('browser-local'))` 是恒真断言（0.3 既有，本次未顺手修正）。

**P2-17** 文档小错：TESTING-2-MACHINES.md:62 快照名示例仍是旧格式 `<时间>-xxxx.dshsync`，实际为 `<机器名>_<UTC时间>_<随机>.dshsync`（README.md:90 是对的）。

**P2-18** 发布前检查单（T7 未执行，属计划内，防止遗漏）：package.json `version` 仍为 0.3.6、lib/engine.js:28 `GENERATOR = 'dsh-sync 0.3.6'` 均待升 0.4.0，CHANGELOG 段落与 tag 未建。**若 T7 漏改 GENERATOR，0.4 产出的快照头会被标记为 0.3.6 生成，影响后续排查**。package.json 的 `description` 也还是 0.3 的旧文案。

---

## 建议（Recommendations）

1. **一次修复 P1-3 + README 一致性**：bundleDelta 提前到 dryRun 返回之前，前端预览面板加"恢复后将自动安装"行，README.md:81 的承诺随之兑现。这是性价比最高的修复。
2. **统一"选择即重置"**：抽一个 `resetPlan()`（setPlan(null) + setConfirmRestore(false)），在快照下拉、filePath 输入、选择文件按钮三处复用，根治 P1-1。
3. **把折中写回设计**：P1-2 无论选择"按设计改"还是"保留现状"，都要在 `docs/redesign-0.4.md` §3.2-3 落一条决策记录（结论 + 日期），避免 T7 之后文档与实现再次分叉。
4. **P1-5 推荐前端侧修复**（去掉勾选触发的重复请求），改动最小且不损失任何能力；后端 preview 语义（全模块统计供决策）保留并在 hint 中说明"数字为该模块全量体积"。
5. **T7 发布清单显式列出**：version、GENERATOR、description、CHANGELOG、tag 五项，逐项打勾。
6. 修复后按流程复跑 `node --test`，并把本报告每个问题的闭环结果标注在对应条目下（对齐设计文档 §5 的约定）。

---

## 移交裁定清单（Declined to judge）

以下行为经审视后未计入问题，逐条说明理由；执行者可推翻：

1. **index.js 定时器 tick 在 push 耗时 >60s 时理论上可重入**——index.js 不在本次 diff 内，为 0.3 既有行为（最小修改原则，超出本层范围）。
2. **`modules.preview` 允许同源页面对 extraPaths 任意目录做存在性/体积探测**——返回值只有计数与字节数，防线（同源 + `x-dsh-sync` 头 + 无 CORS 预览应答）未被本次改动削弱，威胁模型与 `config.save` 相同。
3. **`walkTree` 对文件 `fs.stat` 无 try-catch（readdir 与 stat 之间文件消失会令整个 push 失败）**——util.js 未改动，0.3 既有。
4. **test/engine.test.js:131 恒真断言**——0.3 既有行，本次 diff 未触及；已列入 P2-16 建议顺手修正，但不计为本次回归。
5. **engine.test.js fixture 用旧键 `agentsSkills: false` 保存（test/engine.test.js:54）**——判断为有意借保存路径覆盖迁移逻辑，行为正确，非笔误。
6. **`run()` 的 busy 防重入依赖 state 闭包而非 ref，理论上极快双击可双发**——React 离散事件之间同步 flush 渲染，实际路径不可达；0.3 无任何防重入，本次已是增强。
7. **恢复页读取的是"已保存配置"的目标而非表单草稿**——与显式保存模型自洽，属产品语义选择而非缺陷。
8. **package.json `description` 未更新到 0.4 文案**——归入 T7 发布范围（P2-18 已列）。

---

## 结论（Assessment）

**Ready to merge?** With fixes（修复 P1 后合并）

**理由**：后端模块化、配置迁移、旧快照兼容与加密链路实现扎实且 32/32 测试全绿，最小修改原则与中文注释约束执行到位；主要问题集中在三个设计落地偏差（P1-2 隐式保存、P1-3 安装计划预览、P1-5 preview 语义）与一个恢复确认一致性缺陷（P1-1），外加旧快照 node_modules 兼容例外（P1-4）。全部 P1 修复面都不大（预计半天内），修完并复跑测试即可进入 T7 发布；P2 可在发布前后按建议顺序消化。

---

### 问题闭环记录（修复后填写）

| 编号 | 状态 | 修复提交 / 说明 |
| --- | --- | --- |
| P1-1 | ✅ 已修复 | 新增 `resetPlan()`（client.js），快照下拉、文件路径输入、选择文件/文件夹按钮三处统一复用；路径或快照一变即失效已预览清单 |
| P1-2 | ✅ 已修复（按设计实现） | 移除 onTest/onPush 的隐式 `save()`；dirty 提示条升级为设计形态：说明文案 + [保存并继续] [放弃修改] 按钮；预览保持无隐式保存 |
| P1-3 | ✅ 已修复 | `bundleDelta` 提前到 dryRun 返回之前，summary 附 `bundles`；预览面板显示"恢复后将自动安装 N 个插件包（…）"，恢复后显示"已自动安装"；README.md:81 承诺随之兑现 |
| P1-4 | ✅ 已修复（方案 a+c） | 恢复端特判：本机 `include.nodeModules === true` 时 `profile/node_modules/**` 映射到独立 `node-modules` root 正常恢复；告警归名对 `profile/node_modules/` 前缀单独归为"插件代码"；新增专项测试（关闭跳过并归名 / 开启正常恢复） |
| P1-5 | ✅ 已修复（推荐方案） | 前端勾选不再触发 `modules.preview` 请求（勾选不改变本机数据）；preview 注释明确"全模块全量口径"的决策依据；口径对齐 limits.maxFileMB（>16MB 文件不计入，与真实采集一致） |
| P2-1 | ✅ 已修复 | 死代码 `stat.present = false` 随 previewModules 重写删除 |
| P2-2 | ✅ 已修复 | 注释改为"stat-only 全量遍历"并写明口径 |
| P2-3 | ✅ 已修复 | previewModules 接收 limits，跳过超过 maxFileMB 的文件（engine.previewModules 传入 config.limits） |
| P2-4 | ✅ 已修复 | 预览/文件预览按钮下方补 Progress 渲染 |
| P2-5 | ✅ 已修复（简化方案） | 文案改为"展开更多（至多 50 条）"，如实反映 sample 上限；后端上限保持 50（dryRun 无写盘风险但避免超大响应） |
| P2-6 | ✅ 已修复 | 状态点改为按钮，点击切到高级页详情；状态条补目标类型前缀 |
| P2-7 | ✅ 已修复 | 本地模式空态提供"点此复制"目标路径按钮（含失败降级提示） |
| P2-8 | ✅ 已修复 | setNotice 去掉无人使用的清理函数返回值 |
| P2-9 | ✅ 已修复 | hydrate 重置 feedback / privacyAck / showAllPlan |
| P2-10 | ✅ 已修复 | 互补重复的 warnings 渲染合并为一行 |
| P2-11 | ✅ 已修复 | 删除确认增加"取消"按钮 |
| P2-12 | ✅ 已修复 | migrateIncludeKeys 改为旧键无条件覆盖（0.4 客户端不发旧键，旧键出现即来自旧配置/旧客户端），对话工具传旧键不再丢设置 |
| P2-13 | ⏸ 接受现状 | UI 正常操作不可达（profile 模块无开关）；对话工具显式传 profile:false 属高级用法，跳过并在告警中可见 |
| P2-14 | ✅ 已修复 | mcp/mcp_connector.json 恢复时统一 0600（与 .credentials.yaml、.env 一致） |
| P2-15 | ⏸ 部分修复 | live-verify 的 dshHome 保持临时目录（指向真实 ~/.dsh 会让 state 写入真机——安全设计优先）；无效断言与 catch 吞错已修正路径（真机注释改为如实描述） |
| P2-16 | ✅ 已修复 | 补 homePatch/workspaceRoot 开关用例、status.local.roots present 断言；engine.test.js:131 恒真断言改为 `assert.match(browser-local)` |
| P2-17 | ✅ 已修复 | TESTING-2-MACHINES.md 快照名示例更新为 `<机器名>_<UTC时间>_<随机>.dshsync` |
| P2-18 | ⏳ T7 执行 | version / GENERATOR / description / CHANGELOG / tag 在发布提交中逐项处理 |

**复测结果**：`node --test test/` 34/34 全绿（新增 3 用例：legacy node_modules 兼容、homePatch/workspaceRoot 开关、status.roots present）；`node scripts/live-verify.mjs` 真机验证通过。
