# dsh-sync 0.4 体验重构 · 第三层审查报告（review-report-3 · open-code-review）

- **工具**：ocr（OpenCodeReview CLI，provider: CunAI / gpt-6.1-sol，diff-range 模式）
- **日期**：2026-10-25 ~ 10-26
- **审查范围**：`git diff 99848d0..HEAD`
- **执行说明**：首轮（2026-10-25）ocr 的 LLM 通道持续网络故障，3 次会话部分完成（collect.js 与 live-verify.mjs）。2026-10-26 用户切换 ocr 供应商后补审成功（会话 03388c78，27 请求 26 成功，~86 万 token，3m46s）：**9 个文件全部审查完毕**，仅 `scripts/live-verify.mjs` 因 provider HTTP 400 单文件失败（该文件前轮已审并修复）。以下为全部四轮发现的合并闭环。
  - 会话 6ef9196d（partial）：`lib/collect.js` 完成，3 条发现；
  - 会话 6ec5c088（failed）：8 文件全部网络失败，无产出；
  - 会话 5a0e4de8（aborted，resume 自 6ec5c088）：`locale/zh.json`（0 条）与 `scripts/live-verify.mjs`（3 条）完成，其余 6 文件因 `context canceled` 未完成。
- **覆盖状态（2026-10-26 更新）**：切换供应商后补审完成，9 个文件全部覆盖，无未审查文件。

---

## 发现与闭环

### lib/collect.js（第一轮会话 6ef9196d）

| # | 级别 | 问题 | 状态 |
| --- | --- | --- | --- |
| OCR-1 | bug·high | `nodeModules` 开启后，`SKIP_DIRS` 仍无条件跳过所有名为 `node_modules` 的目录——T1 移除 `includeNodeModules` 参数时删掉了 0.3 的 `skipDirs.delete('node_modules')` 逻辑，导致嵌套 node_modules（pnpm 目录结构）不入归档，离线还原该模块与 0.3 行为不一致 | ✅ 已修复（f3927d8）：node-modules root 使用删除该键的 skipDirs，previewModules 同口径；新增嵌套结构 round-trip 回归测试 |
| OCR-2 | bug·medium | `maxFiles` 只在目录遍历分支检查，文件型 root 无条件加入 entries | ✅ 已修复（f3927d8）：文件分支补齐上限检查与告警 |
| OCR-3 | bug·medium | `maxArchiveMB` 只在目录遍历分支生效，文件型模块合计可超限 | ✅ 已修复（f3927d8）：文件分支补齐总量检查 |

### scripts/live-verify.mjs（第三轮会话 5a0e4de8）

| # | 级别 | 问题 | 状态 |
| --- | --- | --- | --- |
| OCR-4 | test·medium | `!pushed.key.includes('.plugin-manager')` 断言无效——对象键由设备名/时间戳/随机 token 构造，天然不含归档条目路径，快照是否含噪声都能通过 | ✅ 已修复（f3927d8）：改为解包刚上传的快照逐条验证（profile 恰好 6 文件、无 `.plugin-manager/` 前缀） |
| OCR-5 | test·medium | 旧快照噪声过滤未被实际验证——从未检查噪声目标路径的存在或内容 | ✅ 已修复（f3927d8）：预先放置噪声目标文件并断言恢复后内容未被覆盖（unmapped 语义） |
| OCR-6 | maintainability·medium | 临时目录只在脚本末尾清理，任一断言失败都会留下真实 profile 的完整副本（含潜在敏感内容） | ✅ 已修复（f3927d8）：注册 `process.on('exit')` 同步清理，任何失败路径均不残留 |

### locale/zh.json（第三轮会话 5a0e4de8）

0 发现。

### 补审轮（2026-10-26，会话 03388c78，供应商切换后）

| # | 级别 | 位置 | 问题 | 状态 |
| --- | --- | --- | --- | --- |
| OCR-7 | bug·medium | client.js:515 | 切换配置无 dirty 离开保护：改了表单未保存就切配置，草稿被 hydrate 静默重置 | ✅ 已修复：dirty 时拒绝切换、下拉框回弹，就地提示"先保存并继续或放弃修改"（复用现有反馈机制，比 window.confirm 更符合 0.4 就地反馈哲学） |
| OCR-8 | bug·medium | lib/collect.js:153 | 必选模块 `include.profile: false` 可经 sync_configure/API/手改配置进入，UI 显示已勾选但实际未备份 | ✅ 已修复：`completeProfile` 归一化时固化 `profile: true`（必选模块所有消费方一致）；新增覆盖用例 |
| OCR-9 | security·medium | client.js:31 | 隐私声明"不读取、不解析"与实现不符（collectSnapshot 读取内容、credentials 做 UTF-8 解析脱敏、恢复时合并）——错误安全预期 | ✅ 已修复：措辞改为准确承诺（内容不上传任何第三方 / 本机加密后才离开设备 / 凭证剔除设备记录在本机完成 / 无遥测），client.js + README + 设计文档三处同步 |

补审后复测：36/36 测试全绿 + live-verify 真机验证通过。

---

## 复测

- `node --test test/`：**36/36 全绿**（新增嵌套 node_modules round-trip、必选模块固化用例）
- `node scripts/live-verify.mjs`：全部通过（push 3972 文件/8.3MB 密文、dryRun、恢复 round-trip、0.3.x 兼容、噪声不落盘、临时目录自动清理）

**第三层结论**：四轮共 9 条发现（1 high + 7 medium + 1 medium-security），全部闭环。
