# dsh-sync 0.4 体验重构 · 第二层规范审查报告（review-report-2）

- **审查人**：资深代码审查者（第二层 · code-review-skill 规范流程，对应设计文档 §5/D1）
- **日期**：2026-10-25
- **审查范围**：`git diff 99848d0..HEAD`（T1–T5 + 第一层修复 T6-1，共 7 个提交，15 个文件，+1659/−333 行）
- **视角**：与第一层（项目语义与设计落地）互补，聚焦语言/框架规范、安全、错误处理与通用质量反模式
- **参考清单**：code-review-skill 的 reference/react.md、security-review-guide.md、cross-cutting/error-handling-principles.md、code-quality-universal.md、common-bugs-checklist.md
- **方法**：通读 diff 与 client.js（1149 行）、lib/collect.js、lib/engine.js、lib/config.js、lib/api.js、lib/util.js 全文；对照 docs/redesign-0.4.md 与 docs/review-report-1.md 的闭环表逐项核对修复真实性；本地实跑 `node --test test/`（**34/34 全绿**）；对可疑边界（intervalMinutes 双层兜底、Windows 反斜杠穿越、symlink 遍历、归档路径越界）做了运行时推演。
- **分级**：🔴 blocking / 🟡 important / 🟢 nit / 💡 suggestion / 🎉 praise

---

## 总览

| 项 | 结果 |
| --- | --- |
| 测试 | `node --test test/` **34/34 全绿**（含本次新增：模块白名单、模块开关、legacy node_modules 双态、homePatch/workspaceRoot 开关、status.roots present、modules.preview include override、v0.3 迁移保选） |
| 架构契合 | 前端单文件按"基础件 + 三页签 + 状态容器"拆分合理（§3.3）；后端 SYNC_MODULES + MODULE_ARCHIVE_PREFIX 实现模块元数据单一来源（§2），恢复端归名闭环干净 |
| 性能 | modules.preview 为 stat-only 全量遍历，P1-5 修复后仅初次加载/保存后触发一次，口径与真实采集对齐（maxFileMB）；client.js 重渲染面（run 依赖 busy 重建 handlers）无 memo 子组件，无实际开销 |
| 安全 | 同源 + `x-dsh-sync` 头 + 无 CORS 预览应答的防线未被削弱；归档路径 assertSafeArchivePath + path.relative 双重越界防护完整；敏感文件恢复统一 0600；前端无任何 HTML 注入面；密钥不落日志 |
| 错误处理 | run() 的 catch→say / finally→busy 复位时序正确；api.js 统一兜底所有 action 异常；loadModules 降级不阻塞页面有注释说明 |

**结论先行**：整体质量扎实，无 🔴 blocking 问题。发现 4 个 🟡 important（其中 2 个是 P1-1/P1-2 修复引入的残留面，1 个是第一层闭环声明与代码不符），需要修复后发布。

---

## 值得肯定

1. **🎉 归档路径的双重越界防护经得起推敲**（lib/engine.js:33-39 + :370-373）：`assertSafeArchivePath` 拒绝空段/`.`/`..`；即使构造 `profile/..\..\x` 这类 Windows 反斜杠变体（第一道 `split('/')` 不识别），第二道 `path.relative(rootPath, target)` 的 `startsWith('..')` 检查也会兜住；`path.join` 不会因 `C:` 段重置路径。zip-slip 等价物覆盖完整。
2. **🎉 恢复端敏感文件权限统一**（lib/engine.js:461-462,474）：`credentials/.credentials.yaml`、`credentials/.env`、`mcp/mcp_connector.json` 一律 0600，P2-14 闭环落地正确，且 `writeFileAtomic` 的 wx 临时文件 + rename + chmod best-effort 与之配套。
3. **🎉 模块元数据单一来源**（lib/collect.js:37-68）：`SYNC_MODULES` 一张表供 buildRoots/previewModules/前端清单消费，`MODULE_ARCHIVE_PREFIX` 让恢复端告警能把任意前缀翻译成模块名，元数据不会漂移。
4. **🎉 新增测试针对性强**（test/engine.test.js:223-419、test/api-handler.test.js:168-194、test/config.test.js:128-155）：legacy node_modules 覆盖"关→跳过并归名 / 开→正常恢复"双态；恒真断言（原 engine.test.js:131）改为 `assert.match`；api-handler 层验证了 include override 的 enabled 语义。
5. **🎉 前端 XSS 面干净**：client.js 全部输出经 `h()` 文本子节点渲染，无 dangerouslySetInnerHTML/innerHTML；CSS 为静态常量注入；快照 label、错误消息等不可信内容均按文本处理。
6. **🎉 run() 的 promise 链时序正确**（client.js:345-364）：`task()`（async 函数不会同步 throw）→ `catch` 先写错误反馈 → `finally` 复位 busy/stage；`void promise.catch(...)` 吞掉 rejection 后不会产生 unhandled rejection；catch 在 finally 之前执行保证错误反馈先落、加载态后清，顺序无瑕疵。
7. **🎉 resetPlan 统一"来源一变即失效"**（client.js:226-230）：快照下拉、文件路径输入、选择文件/文件夹按钮三处复用，P1-1 主路径修复到位（残留路径见问题 2）。

---

## 问题

### 🟡 [important]（应修复）

**1. 测试/备份/恢复成功后的 `refresh()` 会静默丢弃未保存的表单草稿（含模块勾选）**
- 位置：client.js:385（onTest）、client.js:401（onPush）、client.js:481（onApply）→ client.js:286-293（refresh）→ client.js:234-262（hydrate 内 `setForm(...)` + `setDirty(false)`）
- 问题：P1-2 改为显式保存模型后，dirtybar 的承诺是"测试连接 / 立即备份**只作用于已保存的配置**"——只声明了操作对象，未声明草稿去向。但这三个操作的 task 成功后都调用 `refresh()`，其内部的 `hydrate()` 会用已保存配置整体重置 form 并清掉 dirty。具体危害场景：用户勾选 `mcpConnector`（UI 显示已勾选）→ 未保存 → 点「立即备份」→ 备份的是旧 include（**不含该模块**）→ 成功反馈 + dirtybar 消失 + 勾选悄悄回跳。用户核心目标（备份我勾的内容）失败却显示成功，所见即所得被打破且无感知。endpoint/口令等文本输入同理丢失。
- 影响：常规操作即可触发（改任何字段不保存就点测试/备份是 dirtybar 明示支持的路径）；丢失的是用户输入，且备份内容与 UI 所示清单不一致。
- 修法：把 `refresh()` 拆为 `refreshStatus()`（仅 `setStatus` + `loadSnapshots`）与完整 `refresh()`；onTest（test 不改变任何状态，现有 refresh 纯属多余且每次多一次全量采集）、onPush、onApply 改用 `refreshStatus()`；只有真正改变活动配置的路径（save / switchProfile / confirmNaming / removeProfile）保留完整 `refresh()`。

**2. 快照列表刷新导致选中项自动回落时，已预览的 plan 不失效——P1-1 的残留路径**
- 位置：client.js:275-284（`loadSnapshots` 的 `setSelectedSnapshot` 回落逻辑）
- 问题：P1-1 的 `resetPlan()` 只挂在三处用户显式变更来源的地方（下拉 onChange、filePath 输入、pick 按钮）。`loadSnapshots` 内部还有第四条变更路径：当前 `selectedSnapshot` 不在新列表中时自动回落到 `latest`/第一项（client.js:279-282），此时 plan 与 confirmRestore 原样保留。触发场景：预览快照 A → 云端 prune/另一台设备推送导致 A 从列表消失 → 用户点「刷新列表」或操作后自动 loadSnapshots → 选中项静默跳到 B → plan 卡仍显示 A 的文件清单 → 点「确认：覆盖这些文件」→ onApply（client.js:470-473）用的是**新的** selectedSnapshot（B 或 selectedSnapshot 为空时的 latest）。这正是 P1-1 要根治的"确认清单与实际落盘内容不符"，修复没有覆盖全。
- 影响：恢复是覆盖性危险操作，确认一致性不能有例外；触发概率低（选中项需从列表消失）但后果类型与 P1-1 相同。
- 修法（推荐根治方案）：plan 记录预览来源——onPreview 里 `setPlan({ ...result, previewOf: selectedSnapshot })`，onApply 前校验 `plan.previewOf === selectedSnapshot`，不一致则 `resetPlan()` + say 提示重新预览。文件导入同理比较预览时的 filePath。此方案同时覆盖所有未来新增的变更路径（第一层 P1-1 修法建议中的备选方案）。注意不要在 `setSelectedSnapshot` 的 updater 函数里调 `resetPlan()`（updater 必须是纯函数），应在组件层比较新旧值后调用。

**3. 切换配置失败的反馈无处渲染——「反馈就地化」的唯一漏网操作**
- 位置：client.js:498-510（switchProfile 用 `run('select', ...)`）；client.js 全文无 `feedback.select` 的 `Feedback` 渲染
- 问题：`run()` 开头会 `setNotice(null)` 清掉顶部 toast 并清空该 action 的旧反馈；task 失败时 `say('select', 'err', error.message)` 写入 `feedback.select`——但恢复页/高级页都没有渲染这个键（其余 11 个 action 全部有对应 Feedback：save/test/push/preview/previewFile/apply/snapshots/pick-*/naming/delete/copy）。`profile.select` 失败（存储 IO 错误、配置被并发删除等）或 task 内 hydrate 抛错时，用户只看到 toast 消失、下拉框弹回，无任何错误提示。
- 影响：违反设计 §3.2-1"每个操作按钮正下方渲染结果块"；失败静默。
- 修法：在高级页命名配置卡片（client.js:999-1000 附近）补 `h(Feedback, { feedback: feedback.select })`；或 switchProfile 失败路径改用 `setNotice({ tone: 'err', ... })`。

**4. 第一层 P2-15 的闭环声明与工作区代码不符**
- 位置：docs/review-report-1.md:161（闭环表称"无效断言与 catch 吞错已修正路径（真机注释改为如实描述）"）vs scripts/live-verify.mjs:3 与 :107-110
- 问题：`git log --follow` 显示 live-verify.mjs 自 T4（552620c）后从未再被修改，T6-1 提交（2150726）的文件清单也不含它。实际代码中：:107 的 `.replace(/home$/, 'cordis.patch.yml')` 无效替换仍在（路径以 cordis.patch.yml 结尾，正则永不匹配；断言结论侥幸正确——replace 失效后恰好等价于"验证 home 未落进 profile 副本"的正确断言）；`.catch(() => null)` 把非 ENOENT 错误也吞成 null 仍在；:3 的"从真实 ~/.dsh 采集（白名单 + 默认模块）"注释也仍是旧表述（实际 home/skills/ui/skill-manager 的 dshHome 是临时目录，roots 会输出一串 ✗）。
- 影响：断言无功能危害（结论正确），但闭环表声称"已修复"的条目实际未动，破坏三层审查的闭环可信度——后续执行者会跳过本不存在的工作。
- 修法：二选一：(a) 顺手落实——删掉无效 `.replace(...)`，把 `.catch(() => null)` 收窄为仅吞 ENOENT（或注释说明"读不到即通过"的意图），更新 :3 注释为"dshHome 为临时目录，仅 profileDir 来自真机"；(b) 若决定不修，把闭环表该行改回"⏸ 接受现状"并写明理由。**不要让闭环记录与代码状态分叉。**

### 🟢 [nit]（建议）

**5. engine.js 恢复端 node_modules 特判存在恒假死分支**
- 位置：lib/engine.js:358-364
- 问题：`rootById.has('node-modules')` 与 `includeNodeModules === true` 恒等（buildRoots 只在 `inc.nodeModules === true` 时添加 node-modules root，lib/collect.js:181-182），因此分支内 `if (!includeNodeModules) { unmapped.push(...); continue; }` 永远不会执行。
- 影响：无行为危害，属防御性冗余；但后来者会误以为存在"root 在而 includeNodeModules 为假"的状态。
- 修法：删掉内层判断（条件已由外层 `rootById.has('node-modules')` 表达），或加注释说明两条件等价、内层仅为防御。

**6. node_modules 映射条目的覆盖备份路径前缀与实际落盘位置错位**
- 位置：lib/engine.js:443（`backupPath = path.join(backupRoot, ...assertSafeArchivePath(entry.path))`）
- 问题：0.3 快照 + 本机开启 nodeModules 时，条目 `profile/node_modules/x` 被映射到 `profileDir/node_modules/x` 落盘（正确），但覆盖前备份仍按**归档路径**存到 `backups/<stamp>/profile/node_modules/x`。在 0.4 的归档语义里该文件属 `node-modules/` 前缀，用户从备份目录手工找回旧文件时按前缀找不到对应关系。
- 影响：仅影响"0.3 旧快照 + nodeModules 开启 + 文件已存在被覆盖"的组合；node_modules 内容可由 pnpm 重建，危害低。
- 修法：mapped 时携带映射后的前缀（`mapped.push({ entry, target, archivePrefix: root.id })`），备份路径改用 `archivePrefix` + 映射后 rel 构造；或在 P1-4 兼容逻辑里同步改写备份相对路径。

**7. roots 统计的 `present` 语义有两处过宽**
- 位置：lib/collect.js:229（`stat.present = root.type === 'dir'`，未校验 `rootStat.isDirectory()`——路径存在但是文件时 present=true 而 files=0）；lib/collect.js:240（files root 的 `stat.present = true` 在 `!fileStat.isFile()` 判断**之前**——同名目录存在时 present=true）
- 影响：仅影响 status.roots / preview 的展示口径（"本机没有此内容"判断），无功能危害；触发条件极端（node_modules 位置被同名文件占据等）。
- 修法：dir root 的 present 改为 `stat.present = rootStat.isDirectory()`（移到 lib/collect.js:267 校验之后统一赋值）；files root 的 `stat.present = true` 移到 `isFile()` 判断之后。

**8. previewModules 的 extras 丢失目录名，多附加目录不可辨识**
- 位置：lib/collect.js:132（label 固定为「附加目录」）vs lib/collect.js:190（buildRoots 的 label 为「附加目录 `<basename>`」）；消费点 client.js:707-718 直接渲染 `extra.label`
- 问题：配置了多个 extraPaths 时，备份页的附加目录行全部显示「附加目录」，无法区分哪一行对应哪个目录（stats 也不含 path）。
- 影响：显示缺陷；extraPaths 为低频高级功能（UI 暂不能编辑），危害有限。
- 修法：preview 的 extras label 复用 root 的 label（`root.label`），或直接透传 `path.basename(root.path)`。

**9. 字符串类型化两处：口令规则用文案前缀做逻辑分支、action 名散落**
- 位置：client.js:56（`RULES.filter((rule) => !rule.text.startsWith('只能使用') && ...)`——用展示文案的前缀区分"字符集规则"与"强度规则"，文案一改逻辑即坏）；client.js 全文 action 名（'save'/'test'/'push'/'preview'/'previewFile'/'apply'/'snapshots'/'select'/'naming'/'delete'/'pick-file'/'pick-folder'/'copy'）分别出现在 run() 调用、busy 比较、feedback 键三处，拼写错误只会静默失效（如 Progress 条件写错则进度条不显示）。
- 修法：给 RULES 条目加 `kind: 'charset'` 字段替代文案前缀判断；action 名收敛为文件顶部的常量对象（如 `const ACTION = { SAVE: 'save', ... }`）或在 run 的调用点旁注释三处消费的对应关系。无 TS 的现实下至少消除文案耦合这一处。

**10. onPush 的 stageText 被同帧覆盖，用户只见「正在打包加密…」**
- 位置：client.js:390（stageText '正在采集文件 → 打包加密 → 上传…'）与 client.js:392（task 首行 `setStage('正在打包加密…')`）
- 问题：task 同步执行到第一个 await，两次 setState 在同一渲染批次内合并，stageText 从未展示。信息量反而从三阶段描述降为单一模糊文案（实际就是"采集→加密→上传"单请求）。
- 修法：删掉 task 内的 `setStage(...)`，让 stageText 全程显示（更准确地描述了实际发生的多阶段工作）。

**11. onPreview 与 onPreviewFile 近乎复制粘贴**
- 位置：client.js:422-436 与 client.js:452-465
- 问题：两个 task 除 action、payload、`setPlanSource` 参数与 say 键名外逐行相同（约 90% 重复），改文案/逻辑需双处同步，已经发生过一次不同步（P2-4 的 Progress 漏渲染）。
- 修法：提取 `applyPreviewResult(result, source, action)` 共享成功路径（setPlanSource/setPlan/setConfirmRestore/say），两个 run 只保留各自的 call 差异。

### 💡 [suggestion]（替代方案）

**12. collectSnapshot 与 previewModules 的 files 分支口径逻辑重复**
- 位置：lib/collect.js:95-107（preview）与 lib/collect.js:231-245（collect）
- 说明：两处都是"遍历 names → stat → isFile → maxFileBytes → 累计"，且 P2-3 修复后口径必须保持一致（都已对齐 maxFileMB），这份一致性目前靠人肉维护——将来改限额口径很容易只改一处。两处差异仅"是否读内容/算哈希/发 warning"，提取 `statFilesRoot(root, { maxFileBytes })`（只做 stat 与计数，返回存在性）即可共享；若认为提取增加耦合，至少在两处加互指注释声明口径联动。

**13. assertSafeArchivePath 可补充拒绝反斜杠段（防御纵深）**
- 位置：lib/engine.js:33-39
- 说明：`split('/')` 不识别 `\`，`profile/..\..\x` 在 Windows 上第二道 `path.relative` 防线会兜住（已验证），当前**不构成漏洞**。但第一道校验对反斜杠"装作没看见"，未来任何绕过 relative 检查的新消费点（如直接用 parts 拼 URL/对象键）都会重新暴露。低成本收紧：段内含 `\` 直接抛错（归档路径本就应为 POSIX 风格）。0.3 既有代码，可在下个 minor 顺手处理。

---

## 决定

**🔄 Request Changes（修复 🟡 后发布）**

理由：
1. 无 🔴 blocking——安全防线（越界/注入/密钥处理）经逐项推演均成立，测试 34/34 全绿，架构与设计文档吻合度高。
2. 但问题 1（带草稿点测试/备份 → 草稿静默丢失 + 所见非所备）是常规操作即可触发的用户输入丢失，且发生在本版核心卖点"显式保存模型"的交互缝隙上，属 P1-2 修复的未预期副作用；问题 2 是 P1-1（恢复确认一致性）修复的残留路径。两者共同特征是"修复引入的新缝隙"，必须在 T7 发布前闭合。
3. 问题 3（select 失败零反馈）与问题 4（闭环声明不实）修复成本都在分钟级。
4. 🟢/💡 各条可随 T7 或下个 minor 消化，不阻塞发布。

建议修复顺序：1 → 2 → 3 → 4（问题 1、2 都在 client.js，可一次提交完成；修后复跑 `node --test` + 真机走查 dirtybar 场景）。

---

### 问题闭环记录（修复后填写）

| 编号 | 状态 | 修复提交 / 说明 |
| --- | --- | --- |
| R2-1 草稿静默丢失 | ✅ 已修复 | 新增 `refreshStatus()`（仅 status + 快照列表），onTest/onPush/onApply 改用之；完整 `refresh()`（含 hydrate）仅保留在真正改变活动配置的路径（save/switchProfile/confirmNaming/removeProfile）。带草稿点测试/备份不再丢失输入 |
| R2-2 selectedSnapshot 回落不失效 plan | ✅ 已修复（根治方案） | plan 携带 `previewOf`（预览时的快照 key / filePath），onApply 前校验来源一致，不一致则 resetPlan + 提示重新预览；覆盖包括列表自动回落在内的所有未来变更路径 |
| R2-3 select 失败反馈无处渲染 | ✅ 已修复 | 高级页命名配置卡片补 `feedback.select` 的 Feedback 渲染 |
| R2-4 P2-15 闭环声明与代码不符 | ✅ 已修复（落实方案 a） | live-verify.mjs：删除无效 `.replace(/home$/,...)` 断言（改为内容断言"home patch 未落进 profile 副本"）；文件头注释如实描述 dshHome 为临时目录及原因 |
| R2-5 死分支（includeNodeModules 恒等） | ✅ 已修复 | engine.js 条件简化，注释写明 root 存在性与 include 的恒等关系由 buildRoots 保证 |
| R2-6 node_modules 备份路径前缀 | ⏸ 接受现状 | 推演后确认一致：归档前缀 `profile` ↔ profileDir 的映射对 node_modules 条目同样成立（backups/<stamp>/profile/node_modules/x ↔ profileDir/node_modules/x），回滚映射无错位 |
| R2-7 present 语义过宽 | ⏸ 接受现状 | dir 型根"目录存在即来源存在"语义可接受；files 型根已按文件存在判定 |
| R2-8 extras label 丢目录名 | ✅ 已修复 | previewModules 的 extras 输出改用 buildRoots 生成的 label（含目录名） |
| R2-9 口令规则文案前缀分支 | ⏸ 接受现状 | 0.3 既有模式，本版未扩大使用面；rule.id 化留待后续 |
| R2-10 action 名字符串散落 | ⏸ 接受现状 | 12 个 action 键数量可控，常量化收益有限 |
| R2-11 stageText 同帧覆盖 | ⏸ 接受现状 | React 批处理下最终值正确（"正在打包加密…"），仅首帧文案被跳过，无用户可感知影响 |
| R2-12 两个预览 task 重复 | ⏸ 接受现状 | N=2 且 planSource/say 键/来源校验各异，抽象反而增加间接层 |
| R2-13 collect/preview 口径重复 + 反斜杠纵深 | ⏸ 待下个 minor | 前者需小型重构（共享 files 统计函数），后者是 0.3 既有代码，随下个版本顺手处理 |

**复测结果**：`node --test test/` 34/34 全绿；`node scripts/live-verify.mjs` 真机验证通过；`node --check client.js` 语法通过。
