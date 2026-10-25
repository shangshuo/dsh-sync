# dsh-sync 0.4 体验重构 · 第三层审查报告（review-report-3 · open-code-review）

- **工具**：ocr（OpenCodeReview CLI，provider: CunAI / gpt-6.1-sol，diff-range 模式）
- **日期**：2026-10-25 ~ 10-26
- **审查范围**：`git diff 99848d0..HEAD`
- **执行说明**：ocr 的 LLM 通道在本轮期间持续网络故障（`Post "https://www.cun.ai/v1/messages": EOF / connection reset`，共 3 次会话、31+ 请求重试），最终**部分完成**：
  - 会话 6ef9196d（partial）：`lib/collect.js` 完成，3 条发现；
  - 会话 6ec5c088（failed）：8 文件全部网络失败，无产出；
  - 会话 5a0e4de8（aborted，resume 自 6ec5c088）：`locale/zh.json`（0 条）与 `scripts/live-verify.mjs`（3 条）完成，其余 6 文件因 `context canceled` 未完成。
- **未覆盖声明**：`client.js`、`lib/api.js`、`lib/config.js`、`lib/engine.js`、`lib/tools.js` 及修复后的 `lib/collect.js` 复审未由 ocr 完成。前两者已由第一层（设计落地视角）与第二层（语言/安全规范视角）覆盖，ocr 视角（diff 级回归风险）对这 6 个文件的补审可通过以下命令续跑：
  `ocr review --from 99848d0 --to HEAD --resume 5a0e4de8-e2be-464a-84f5-ce10a510b9c9`

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

### 未完成复审的文件

`client.js`、`lib/api.js`、`lib/config.js`、`lib/engine.js`、`lib/tools.js`、修复后的 `lib/collect.js` ——因 LLM 通道故障未完成。第一、二层已覆盖其设计与规范视角；ocr 补审命令见文首。

---

## 复测

- `node --test test/`：**35/35 全绿**（新增嵌套 node_modules round-trip 用例）
- `node scripts/live-verify.mjs`：全部通过（push 3972 文件/8.3MB 密文、dryRun、恢复 round-trip、0.3.x 兼容、噪声不落盘、临时目录自动清理）
