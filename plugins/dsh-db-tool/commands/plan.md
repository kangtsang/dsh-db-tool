---
description: 规划 dsh-db-tool 开发任务：定位相关模块与调用链、列出影响面与测试策略
argument-hint: "[任务描述]"
---

# dsh-db-tool 开发任务规划

你要在 dsh-db-tool（DSH 数据库工具模块，TypeScript + vitest）中为下述任务制定开发计划。本阶段只产出规划，**不修改任何代码**；规划经用户确认后才动手。

## 任务描述

$ARGUMENTS

## 第一步：解析任务类型

根据任务描述判断属于哪一类，规划侧重点随之不同：

- **新功能**：明确新增 API 还是适配器能力，识别需要扩展的层（http → manager → adapters/store）
- **修复**：先要求描述复现现象，规划里必须给出根因假设与验证方式
- **重构**：明确行为不变承诺，列出等价性验证手段
- **传输相关**：改的是 lib/adapters/transfer/ 或某适配器传输实现时，追加核对八库传输边界（见 /dsh-db-tool:workflow 中的已知边界清单；八库 = 九库中除 Redis 外的结构化传输库）

## 第二步：定位待改符号与调用方

- 若仓库根目录存在 `.codegraph/`，优先用 `codegraph explore "<符号或问题>"` 获取源码与调用路径，辅以 `node` / `callers` / `callees` / `impact` 子命令；不做全量 grep
- 否则按模块路径定位：
  - `lib/adapters/` — 九库适配器（mysql、postgresql、oracle、sqlite、dmdb、gaussdb、mongodb、redis、sqlserver），各自 index.ts 导出 createXxxAdapter 与 factory；SQL 共享工具在 `lib/adapters/sql-shared/common`（quoteIdent/assertIdent/humanize）
  - `lib/manager/` — DbToolService（audit 审计、toDriverError）
  - `lib/store/` — 连接与项目配置（normalizeProjectKey）
  - `lib/http/` — API 路由（/api/connections、/api/query、/api/execute、/api/console/*、/api/transfer/start、/api/state、/api/project-context）
- 找到目标符号后，枚举其**全部调用方**（grep 或 codegraph callers），修复类任务优先确认改动是否应落在共享函数

## 第三步：输出规划

按以下结构给出规划，逐项写清：

1. **根因或改动点**：修复任务给根因；新功能给改动点与涉及文件
2. **影响面清单**：列出会被波及的调用方文件（含具体路径），标注哪些行为会变、哪些承诺不变
3. **测试策略**：
   - 修复任务先写复现失败的测试，再实现
   - 覆盖 happy path + 边界/空值/异常
   - 明确要跑的 vitest 文件（相关测试优先，尤其 `tests/adapters-sql/*.test.ts`）
   - 涉及适配器 SQL 语义时，对照 tests/adapters-sql 既有用例核对九库方言差异
4. **风险与回滚点**：改动是否跨模块/涉及公共 API；给出最小回滚方式（如单文件 revert、开关）

## 第四步：等待确认

把规划完整呈现给用户，明确询问是否按此执行。**用户确认前不写任何代码**；用户有异议则按反馈修订规划再确认。
