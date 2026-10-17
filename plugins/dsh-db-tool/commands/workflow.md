---
description: 执行或开发八库数据传输工作流：连库、结构迁移、批量传输与校验
argument-hint: "[源库 目标库 或 传输任务描述]"
---

# dsh-db-tool 数据传输工作流

处理八库（mysql、postgresql、oracle、sqlite、dmdb、gaussdb、mongodb、sqlserver）数据传输相关的执行或开发任务。Redis 不在结构化传输范围内：它没有 SQL 与表结构，交互入口只有 `run_script` 的命令数组。

## 任务描述

$ARGUMENTS

## 第一步：判定意图

根据任务描述区分两种意图，对应完全不同的动作路径：

### (a) 跑一次跨库传输

用现有能力执行传输，不改代码：

1. **连接**：从 `/api/connections` 获取源库与目标库的现有连接配置（口令为加密存储，跨机迁移走导出/导入接口，不要手拼连接串）
2. **发起**：调用 `/api/transfer/start` 启动传输；结构字段属性随数据一并迁移，无需单独跑 DDL 同步
3. **并行**：多表传输可启用并行传输；注意目标库写入能力限制（见下方边界清单，尤其 SQLite 单写者）
4. 执行前向用户复述：源库、目标库、涉及表、是否并行，确认无误再发起

### (b) 开发/修复传输代码

1. 定位实现：传输核心在 `lib/adapters/transfer/`（八库互传 + 并行传输），涉及具体库的读写逻辑在该适配器目录（如 `lib/adapters/oracle/`）
2. 理清调用链：`lib/http/` 的 `/api/transfer/start` 路由 → `lib/manager/` DbToolService（audit 审计、toDriverError）→ transfer/adapter
3. 按下方边界清单核对该库的实现是否踩坑

## 第二步：八库批量传输已知边界

开发或执行前按目标库逐条核对：

- **Oracle**：executeMany 绑定变量有上限，超限报 DPI-1015，写入必须分批
- **PostgreSQL**：驱动无原生 COPY，批量读取用 pg-cursor 游标流式取数
- **MongoDB**：bulkWrite 保持 ordered，保证写入顺序与错误可定位
- **SQLite**：单写者锁，并行写入会互相阻塞或报锁冲突，串行写入
- **SQL Server**：写入走参数化多行 `VALUES` INSERT，TDS 单语句参数上限 2100、`VALUES` 表值构造器单语句最多 1000 行（每语句行数 = `min(floor(2100 / 列数), 1000)`），不用 bulk copy / TVP；分页按目标库版本分流——2012+ 用 `OFFSET/FETCH`，**2008/2008R2 降级可用**（有序游标 keyset/range 用 `SELECT TOP (n) ... ORDER BY key`，无分片键的 offset 全序与 `keyAt` 切块用 `ROW_NUMBER() OVER (...)` 子查询；版本探测失败按 0 走保守降级）；类型搬运有损——`hierarchyid`/`geometry`/`geography` 落 `VARBINARY(MAX)`（UDT 类型语义不保留）、`sql_variant` 转文本（原类型信息丢失）、`varchar/char(4001–8000)` 落 `NVARCHAR(MAX)` 类（保容量不收窄）、`datetime2`/`time` 读端 `CONVERT(..., 126)` 保真、decimal 靠读端 `CONVERT(nvarchar(64), col)` 保真；目标表已存在且该列为 IDENTITY 时写入显式值报错 544（不自动 `SET IDENTITY_INSERT ON`）；建表 DDL 在显式事务中可回滚，不需 Oracle/DM 式的隐式提交处理；replace/ignore 走 `MERGE`
- 跨库传输时同时核对**源库读取边界**与**目标库写入边界**（如 Oracle → SQLite：既要分批读，又要串行写）

## 第三步：传输校验

传输完成后必须校验，全部通过才算完成：

1. **行数比对**：源表与目标表行数一致（count 比对，逐表核对）
2. **抽样字段比对**：按主键抽样若干行，逐字段比对值（注意各库类型映射差异，如数值精度、时区、二进制）
3. **结构一致性**：用各库 describeTable 对照源与目标的列名、类型、可空性、默认值是否随迁一致

校验不通过时，报告差异明细（表、行、字段、期望值与实际值），不要静默重传。

## 修复类任务纪律

- **先写复现失败的测试**（vitest，放 `tests/adapters-sql/` 或对应测试目录），复现后再修
- 修根因不修症状：优先改共享函数（如 transfer 公共层或 `lib/adapters/sql-shared/common`），不在单个调用点打补丁
- 改完跑相关测试验证，涉及 SQL 语义的对照 tests/adapters-sql 既有用例核对八库方言差异
- 只改与问题直接相关的代码，不顺手重构
