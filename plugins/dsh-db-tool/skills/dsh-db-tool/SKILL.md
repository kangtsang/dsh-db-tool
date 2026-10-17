---
name: dsh-db-tool
description: dsh-db-tool（DSH 宿主数据库工具模块，TypeScript）开发技能。在本仓库开发、新增或修改九库适配器（mysql/postgresql/oracle/sqlite/dmdb/gaussdb/mongodb/redis/sqlserver）、编写 SQL 方言相关代码、实现或调试数据传输（transfer）、处理九库差异（标识符引用、批量写入、错误人性化）、调整 API 路由或 store 配置时使用。
---

# dsh-db-tool 开发技能

## 模块地图

| 路径 | 职责 |
| --- | --- |
| `lib/http/index.ts` | API 路由分发层（只做路由与参数，业务下沉 manager） |
| `lib/manager.ts` | `DbToolService`：审计（`audit`）、错误转换（`toDriverError`）、`DbToolError` |
| `lib/adapters/index.ts` | `getAdapter(kind)` 统一入口；驱动缺失统一抛 `driverMissingError(kind, cause?)` |
| `lib/adapters/<kind>/index.ts` | 方言适配器：mysql、postgresql、oracle、sqlite、dmdb、gaussdb、mongodb、redis、sqlserver（九库，注册表见 `lib/adapters/index.ts` 的 `LOADERS`） |
| `lib/adapters/sql-shared/common.ts` | 共享 SQL 工具：`assertIdent`、`quoteIdent`、`clampLimit`、`clampOffset`、`normalizeCell`、`humanize`（高扇入热点，改前查全部调用方） |
| `lib/adapters/sql-shared/pg-like.ts` | PostgreSQL/GaussDB 共享：`normalizeUrl`（多主机 URL 解析/重组）、`pickHost`（探活选主机） |
| `lib/adapters/transfer/` | 传输模型 `model.ts`（`TransferCursor`/`TransferRow`/`readBatch`）+ `kinds/`（mongo、mysql、oralike、pg、sqlite、sqlserver 六类方言实现，覆盖除 redis 外的八个 kind） |
| `lib/transfer.ts` | 传输编排器：表级并行 + 大表按 `keyAt` 分片并行 |
| `lib/store/` | 连接与项目配置：`connections`、`audit`、`export-crypto`（口令加解密）、`normalize.ts`（`normalizeProjectKey` 高扇入）、`secrets` |
| `lib/guard/` | 鉴权 |
| `tests/adapters-sql/` | vitest 测试；仓库根 `stryker.config.json` 变异测试（`disable all`/`restore all` 指令） |

API 面（`lib/http/index.ts`）：`/api/connections`（CRUD + `/export`、`/import` 口令加密跨机迁移）、`/api/query`、`/api/execute`、`/api/console/begin|exec|commit|rollback`（粘性连接，begin 发 token，事务内必须走同一连接读）、`/api/transfer/start`、`/api/state`、`/api/project-context` 等。

## 适配器开发规范

1. 新增/修改方言前先对照最接近的既有适配器：PG 系看 `sql-shared/pg-like.ts` 复用；Oracle/达梦同族看 `transfer/kinds/oralike.ts`。
2. 导出模式（对照 `lib/adapters/mysql/index.ts`）：`export async function createXxxAdapter(conn)` + `export const factory: AdapterFactory = (conn) => createXxxAdapter(conn)`；不要绕过 factory 直接 new。
3. 驱动包缺失一律经 `lib/adapters/index.ts` 的 `driverMissingError` 抛出（`getAdapter` 内已统一处理），适配器内不要自造错误文案。
4. 标识符只用 `quoteIdent`/`assertIdent`，禁止字符串拼接表名列名；查询侧复用 `clampLimit`/`clampOffset`、`normalizeCell`，错误包装复用 `humanize`。
5. SQL 共享工具（common.ts、pg-like.ts、normalizeProjectKey）是高扇入热点：修改前 grep 全部调用方，在共享函数一处修，禁止在各调用点打补丁。

## 九库差异速查

| 场景 | 坑 |
| --- | --- |
| 批量写入 | Oracle 族绑定占位 `:b1..`，单批绑定参数总量有上限（DPI-1015），宽表需减小批次；DM 兼容靠消息匹配唯一冲突（ORA-00001 / `-6602`），勿精确匹配错误码；MongoDB `bulkWrite` 用 `ordered: false`，必须先全量转换再写（转换抛错→一条不写），无跨批次事务（需副本集）；SQLite 单写者，写入用 `BEGIN IMMEDIATE` 包裹；PG 族传输写入走参数化 INSERT 批量（无 COPY） |
| 标识符引用 | `quoteIdent(name, quote)` 默认双引号，MySQL 传 `` ` ``；内部先过 `assertIdent` 防注入，转义为引号翻倍 |
| 错误人性化 | 适配器内用 `humanize(label, fn)` 包装，manager 层再过 `toDriverError`；不要在路由层裸抛驱动原始错误 |
| GaussDB | URL 经 `normalizeUrl`+`pickHost` 支持多主机探活；运行时 failover 与 IPv6 是已知天花板，勿承诺修复 |
| SQL Server | 只按 2005+ 通用写法：元数据只走 `sys.*` catalog views；分页按版本分流（2012+ 用 `OFFSET/FETCH`，2008/2008R2 降级 `ROW_NUMBER`；传输同规则，有序游标用 `SELECT TOP (n)`，版本探测失败按 0 保守降级）；标识符 `[x]` 且 `]` 双写为 `]]`；对外占位符 `?`，适配器内部重写为 `@p1`；TDS 版本可配（默认 `7_4`，可 `7_3_A`/`7_3_B`/`7_2`/`7_1`，**不支持 `8_0` 与 `encrypt='strict'`**）；仅 SQL 认证，无 Windows 集成认证 / Azure AD；传输批量写入每语句行数 = `min(floor(2100 / 列数), 1000)`；连 2008/2008R2 通常要 `?trustServerCertificate=true`；类型搬运：`hierarchyid`/`geometry`/`geography` → bytes（目标 `VARBINARY(MAX)`，UDT 语义不保留）、`sql_variant` → 文本（原类型丢失）、`varchar/char(4001–8000)` → `NVARCHAR(MAX)` 类、`datetime2`/`time` 读端 `CONVERT(..., 126)` 保真、decimal 只在传输读端经 `CONVERT(nvarchar(64), col)` 保真（浏览侧不保真）；**ro 闸门五道**（首词白名单 + 多语句 + `SELECT ... INTO` + `WITH` 写体 + `OPENQUERY`/`OPENROWSET`/`OPENDATASOURCE` 全拒）；控制台 `GO n` 重复计数上限 1000（超出截断） |

## 传输工作流要点

- 入口：`POST /api/transfer/start` → `lib/transfer.ts` 编排器 → `lib/adapters/transfer/` 按 source/target kind 取 `kinds/*` 实现。
- 结构随迁：目标端建表在 `kinds/*` 的 `createTable`（Oracle/DM 族 DDL 隐式提交，需 `autoCommit: true`）。
- 游标：`TransferCursor` 支持 `keyset` 与 `range`（分片并行，hi 端恒开区间）；源未实现 `keyAt` 切块时编排层回退 keyset 链。
- 并行：表级每表独立 reader/writer 连接；表内分片并行依赖源 `keyAt`。
- 行宽校验：写入前逐行校验列数（`行宽不匹配` 报错），勿跳过。
- 相关测试：`tests/adapters-sql/transfer-*.test.ts`（含 `transfer-sqlite.test.ts`、`transfer-mapping.test.ts`、`transfer-task.test.ts`）。

## 验证纪律

- bug 修复先写复现失败的测试，再定位根因、在共享函数一处修；禁止顺手重构无关代码。
- 改动后跑相关 vitest（`npx vitest run tests/adapters-sql/<相关>.test.ts`）验证，未过不算完成。
- 注释与提交信息用简体中文；提交格式 `类型(范围): 描述`，类型取：新增/修复/文档/重构/测试/性能/杂项。
- Windows 环境：无 shell 时 spawn npm 需写 `npm.cmd`。
