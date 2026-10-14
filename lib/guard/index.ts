/**
 * 语句风险分级 + 一次性挑战（用户确认）凭据存储。
 *
 * classifyStatement：把任意 kind 的一条语句分为 'danger' | 'warning' | 'none'，
 * 并给出中文原因。Redis/Mongo 危险清单直接复用各适配器导出的官方清单；
 * SQL 系按首个关键字 + 语句内危险片段识别。
 */
import { createHash, randomBytes } from 'node:crypto';
import { DANGEROUS_COMMANDS, READ_COMMANDS, WRITE_COMMANDS, parseRedisCommand } from '../adapters/redis/index.js';
import { DANGEROUS_OPS, READ_OPS } from '../adapters/mongodb/index.js';
import type { DbKind } from '../adapters/types.js';

export type DangerLevel = 'danger' | 'warning' | 'none';

export interface GuardVerdict {
  level: DangerLevel;
  /** 中文原因：danger 时必给出，说明为何需要用户确认 */
  reason?: string;
}

/** SQL 读取类首词白名单（大小写不敏感；首词必须命中，否则视为非读）。
 *  导出供控制台事务会话 exec 通道复用：读语句走 query 通道保留结果集。
 *  类型收紧为 ReadonlySet——security 原语不允许调用方增删条目（编译期保证，运行时不变）。 */
export const SQL_READ_HEADS: ReadonlySet<string> = new Set([
  'select', 'with', 'show', 'describe', 'desc', 'explain', 'use', 'set', 'help', 'table',
]);

/** DDL：隐式提交、不可回滚 */
const SQL_DDL_RE = /^\s*(drop|truncate|alter|create|rename|comment|grant|revoke|flashback|purge)\b/i;
/** DML：修改数据 */
const SQL_DML_RE = /^\s*(insert|update|delete|merge|replace|upsert|call|do)\b/i;
/** 维护类（oracle/dm 等：shutdown/startup/analyze 等） */
const SQL_MAINT_RE = /^\s*(shutdown|startup|archive\s+log|recover|analyze|optimize|check\s+table|repair|lock|unlock|kill|flush)\b/i;

/** 读取语句内出现即 danger 的片段（多语句、文件读写、全局设置、跨行锁读） */
const SQL_HIDDEN_DANGER_RE = /[;]\s*\S|into\s+(outfile|dumpfile)|load_file\s*\(|set\s+(global|persist)|select\s+[\s\S]*\bfor\s+update\b/i;
/** 读语句体内出现写关键字即 danger（WITH...DELETE / EXPLAIN ANALYZE DELETE 等） */
const SQL_WRITE_BODY_RE = /\b(insert|update|delete|merge|drop|alter|truncate)\b/i;

/** SQL Server（T-SQL）专属高危首词。**仅 kind = 'sqlserver' 时启用**——通用 DDL/DML/MAINT
 *  正则一律不动（既有 8 库判定口径保持不变）。
 *  T-SQL 把这些语句的首词写成通用正则之外（backup/restore/dbcc/reconfigure/bulk），若不追加
 *  会在 execute 通道静默降级为 warning，确认门槛失效：
 *   - BACKUP / RESTORE：整库/日志备份与还原（可覆盖生产数据）
 *   - DBCC：修复/收缩/重建，部分选项会破坏数据页
 *   - RECONFIGURE / sp_configure：改实例级选项（含启用 xp_cmdshell、CLR、OLE 自动化）
 *   - BULK INSERT：从服务器可访问路径直接加载数据（绕应用层校验）
 *   - xp_cmdshell：扩展存储过程，可执行任意 OS 命令
 *  SHUTDOWN 已在通用 SQL_MAINT_RE 命中，此处列出只为给出 T-SQL 专属原因文案。 */
export const SQLSERVER_DANGER_HEADS: ReadonlySet<string> = new Set([
  'backup', 'restore', 'dbcc', 'reconfigure', 'bulk', 'shutdown', 'sp_configure', 'xp_cmdshell',
]);

/** T-SQL 语句体内出现即 danger 的形态：EXEC/EXECUTE 后接扩展存储过程 xp_*、sp_configure
 *  或 sp_executesql（动态 SQL 入口）。覆盖 `EXEC xp_cmdshell`、`EXEC master..xp_cmdshell`、
 *  `EXEC @rc = master.dbo.xp_cmdshell`、`EXEC sp_configure 'show advanced options', 1`、
 *  `EXEC sp_executesql N'DROP TABLE t'`，以及远端字符串形态 `OPENQUERY(ls,'EXEC xp_...')`。
 *  中间限长 200 字符，防跨语句误命中。
 *  **用「仅剥注释」的 body 判定，不用剥字面量的结构文本**：动态执行的证据就在字面量里，
 *  剥掉就看不见了。代价是 `SELECT 'EXEC xp_cmdshell' AS s` 这类把该词写进字符串的读语句
 *  也会要求确认（fail-closed，宁可多确认一次）。 */
const SQLSERVER_DANGER_BODY_RE = /\bexec(?:ute)?\b[\s\S]{0,200}?\b(?:xp_\w+|sp_configure|sp_executesql)\b/i;

/** T-SQL 动态 SQL 执行形态本身即 danger：EXEC/EXECUTE 后跟括号起始的字符串（`EXEC('…')`）、
 *  字符串字面量（`EXEC N'…'` / `EXEC '…'`）或变量（`EXEC @sql` / `EXEC(@sql)`）——被执行的
 *  文本在确认时不可知，静态清单无法判定其内容，故一律确认。
 *  对照（不误报）：`EXEC sp_who`、`EXEC dbo.usp_x`（静态对象名，走通用未识别 warning）。
 *  同样用「仅剥注释」的 body 判定（需要看到括号与引号本身）。 */
const SQLSERVER_DYNAMIC_EXEC_RE = /\bexec(?:ute)?\s*(?:\(\s*)?(?:n\s*)?(?:'|@\w+)/i;

/** T-SQL 的 `SELECT ... INTO <表|#临时表>` 会创建对象（建表副作用），但通用
 *  SQL_HIDDEN_DANGER_RE 的 into 只认 MySQL 的 OUTFILE/DUMPFILE，不覆盖该形态。
 *  - 要求 select 在 into 之前（不误伤 INSERT INTO / MERGE ... USING）；
 *  - `(?<!\bas\s)`：`SELECT 1 AS into FROM t` 的 into 是列别名，不是建表目标；
 *  - `(?!@)`：`INTO @t` 是表变量/变量赋值，不产生永久对象，放行（若日后要连表变量一起挡，
 *    去掉该段即可，代价是 `SELECT 1 INTO @t` 这类常见写法每次都要确认）。
 *  残留误报：`SELECT a FROM t ORDER BY into`（into 作未引用列名）会要求确认——fail-closed，
 *  正常写法列名会加 [ ] 而结构文本已剥掉方括号标识符。 */
const SQLSERVER_SELECT_INTO_RE = /(?<!\bas\s)\binto\s+(?!@)/i;

/** 剥掉字符串字面量与带引号标识符，只留 SQL 结构：单引号串（'' 转义，含 N 前缀）、
 *  双引号标识符、方括号标识符（]] 转义）统一替换为空白。供 sqlserver 专属词法判定使用，
 *  使 `SELECT 'into tbl'` / `SELECT [into] FROM t` 不被 INTO 规则误伤。 */
function stripSqlLiterals(statement: string): string {
  let out = '';
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!;
    if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      for (; j < statement.length; j++) {
        if (statement[j] !== close) continue;
        if (statement[j + 1] === close) { j++; continue; } // '' / "" / ]] 转义
        break;
      }
      i = j; // 跳到闭合符（for 再 ++ 到其后）
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** MongoDB 读操作白名单（复用 mongodb 适配器导出的 READ_OPS，单一事实来源） */
const MONGO_READ_OPS: ReadonlySet<string> = READ_OPS;

/** MongoDB 写操作清单（适配器未导出，此处按 DANGEROUS_OPS 之外的写命令复述；含命令文档形式 insert/update/delete/create） */
const MONGO_WRITE_OPS: ReadonlySet<string> = new Set([
  'insert', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'update', 'replaceOne', 'findOneAndUpdate', 'findAndModify', 'bulkWrite',
  'deleteOne', 'deleteMany', 'delete',
  'createCollection', 'create', 'renameCollection', 'mapReduce',
]);

/**
 * 命令文档形式的删集合：{ drop: 'coll' } 语义等同 dropCollection（删整个集合），
 * 但适配器导出的 DANGEROUS_OPS 只含 helper 形式（dropCollection），故此处按 danger 补位。
 */
const MONGO_DANGEROUS_EXTRA: ReadonlySet<string> = new Set(['drop']);

/** 剥掉块注释/行注释（sqlHead 与语句体分析共用；写词藏在注释里不应触发分级） */
function stripSqlComments(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

/** 首个 SQL 关键字（剥掉注释与括号） */
export function sqlHead(statement: string): string {
  const s = stripSqlComments(statement).trim();
  const m = /^[\s(]*([a-zA-Z_]+)/.exec(s);
  return m?.[1]?.toLowerCase() ?? '';
}

/** 语句 SHA256（challenge 绑定用；trim 后哈希） */
export function statementHash(statement: string): string {
  return createHash('sha256').update(statement.trim(), 'utf8').digest('hex');
}

/**
 * 语句风险分级。op 指明调用通道：query 通道收到任何写语句一律 danger
 * （只读通道混入写）；execute 通道 SELECT 类放行（如 SELECT ... INTO 之外
 * 的合法场景由各适配器会话级只读兜底）。
 */
export function classifyStatement(kind: DbKind, statement: string, op: 'query' | 'execute'): GuardVerdict {
  if (kind === 'redis') return classifyRedis(statement, op);
  if (kind === 'mongodb') return classifyMongo(statement, op);
  return classifySql(kind, statement, op);
}

/* ---------------- SQL 系（mysql/postgresql/gaussdb/sqlite/oracle/dmdb/sqlserver） ---------------- */

function classifySql(kind: DbKind, statement: string, op: 'query' | 'execute'): GuardVerdict {
  const head = sqlHead(statement);
  if (head === '') return { level: 'danger', reason: '无法解析语句关键字，按危险语句处理' };

  // 语句体分析一律基于剥注释后的文本：写词藏在注释里不应触发分级（误报），
  // 前导注释也不能使 DDL/DML 锚定失效（漏报——否则 /* x */ DROP 绕过确认）
  const body = stripSqlComments(statement);

  // T-SQL 专属高危（BACKUP/RESTORE/DBCC/RECONFIGURE/sp_configure/xp_*/动态 SQL）先判：
  // 这些形态不落在通用 DDL/DML/MAINT 正则上，不先判会降级为 warning（详见各常量注释）。
  // 只对 sqlserver 生效，通用正则与其它 kind 的判定口径不受影响。
  if (kind === 'sqlserver') {
    // 1) 首词危险清单 与 动态执行证据（EXEC … xp_*/sp_configure/sp_executesql、EXEC('…')、
    //    EXEC @sql）都用「仅剥注释」的 body 判：动态执行的证据在字面量里，剥掉就看不见了。
    if (SQLSERVER_DANGER_HEADS.has(head)
      || SQLSERVER_DANGER_BODY_RE.test(body)
      || SQLSERVER_DYNAMIC_EXEC_RE.test(body)) {
      return { level: 'danger', reason: 'T-SQL 高危语句（备份/还原/DBCC/实例配置/扩展存储过程/动态 SQL），需要确认' };
    }
    // 2) 读头（select/with/show/set/…）就地判定并返回，把「写体扫描」换成剥字面量后的结构文本：
    //    `OPENQUERY(ls,'DELETE FROM t')` 的 delete 在远端字符串里，不是本语句的写操作（不升级）；
    //    而「多语句/未闭合字面量」仍用原文判——`SELECT 'a''; DROP TABLE t` 的第二条语句正是要拦的。
    if (SQL_READ_HEADS.has(head)) {
      if (SQL_HIDDEN_DANGER_RE.test(body)) {
        return { level: 'danger', reason: '读语句包含危险片段（多语句 / 文件读写 / 全局设置 / 锁读），需要确认' };
      }
      const struct = stripSqlLiterals(body);
      if (SQL_WRITE_BODY_RE.test(struct)) {
        return { level: 'danger', reason: '读语句体内包含写操作关键字（如 WITH...DELETE / EXPLAIN 写语句），需要确认' };
      }
      // 3) SELECT ... INTO <表/临时表>：T-SQL 建表副作用（DDL 级），通用正则不覆盖（详见常量注释）。
      //    已由上面写体扫描排除 WITH … INSERT INTO … SELECT（那是写操作，理由应指向写操作，不误挂这里）。
      if ((head === 'select' || head === 'with') && SQLSERVER_SELECT_INTO_RE.test(struct)) {
        return { level: 'danger', reason: 'T-SQL SELECT ... INTO 会创建目标表（DDL 副作用），需要确认' };
      }
      return { level: 'none' };
    }
  }

  const isRead = SQL_READ_HEADS.has(head);
  if (isRead) {
    if (SQL_HIDDEN_DANGER_RE.test(body)) {
      return { level: 'danger', reason: '读语句包含危险片段（多语句 / 文件读写 / 全局设置 / 锁读），需要确认' };
    }
    // 读头不等于只读：WITH...DELETE / EXPLAIN ANALYZE DELETE 语句体内含写关键字
    if (SQL_WRITE_BODY_RE.test(body)) {
      return { level: 'danger', reason: '读语句体内包含写操作关键字（如 WITH...DELETE / EXPLAIN 写语句），需要确认' };
    }
    return { level: 'none' };
  }

  if (SQL_DDL_RE.test(body)) return { level: 'danger', reason: 'DDL 不可回滚（隐式提交），可能破坏表结构或数据' };
  if (SQL_DML_RE.test(body)) {
    if (op === 'query') return { level: 'danger', reason: '只读通道（query）出现写语句，需要确认' };
    return { level: 'warning', reason: '写操作将修改数据' };
  }
  if (SQL_MAINT_RE.test(body)) return { level: 'danger', reason: '维护/管理命令影响服务器状态，需要确认' };

  // 未知关键字：execute 通道 warning（适配器只读兜底），query 通道 danger
  if (op === 'query') return { level: 'danger', reason: `只读通道（query）出现非读取语句（${head}），需要确认` };
  return { level: 'warning', reason: `未识别的语句类型（${head}），请确认后执行` };
}

/* ---------------- Redis ---------------- */

function classifyRedis(statement: string, op: 'query' | 'execute'): GuardVerdict {
  const parts = parseRedisCommand(statement);
  const head = (parts[0] ?? '').toUpperCase();
  if (head === '') return { level: 'danger', reason: '无法解析 Redis 命令，按危险命令处理' };

  if (DANGEROUS_COMMANDS.has(head)) {
    return { level: 'danger', reason: `Redis 危险命令 ${head}，可能清空/重配置实例，需要确认` };
  }
  if (WRITE_COMMANDS.has(head)) {
    if (op === 'query') return { level: 'danger', reason: `只读通道（query）出现 Redis 写命令 ${head}，需要确认` };
    return { level: 'warning', reason: `Redis 写命令 ${head} 将修改数据` };
  }
  if (READ_COMMANDS.has(head)) return { level: 'none' };
  if (op === 'query') return { level: 'danger', reason: `只读通道（query）出现未识别的 Redis 命令（${head}），需要确认` };
  return { level: 'warning', reason: `未识别的 Redis 命令（${head}），请确认后执行` };
}

/* ---------------- MongoDB ---------------- */

/** MongoDB 命令：JSON 对象，首键为操作名 */
function classifyMongo(statement: string, op: 'query' | 'execute'): GuardVerdict {
  let head = '';
  try {
    const parsed: unknown = JSON.parse(statement);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      head = Object.keys(parsed as Record<string, unknown>)[0] ?? '';
    }
  } catch {
    return { level: 'danger', reason: 'MongoDB 命令不是合法 JSON 对象，按危险命令处理' };
  }
  if (head === '') return { level: 'danger', reason: '无法解析 MongoDB 命令，按危险命令处理' };

  if (DANGEROUS_OPS.has(head)) {
    return { level: 'danger', reason: `MongoDB 危险操作 ${head}，可能删库/删集合，需要确认` };
  }
  if (MONGO_DANGEROUS_EXTRA.has(head)) {
    return { level: 'danger', reason: `MongoDB 危险操作 ${head}（删除整个集合，等同 dropCollection），需要确认` };
  }
  if (MONGO_WRITE_OPS.has(head)) {
    if (op === 'query') return { level: 'danger', reason: `只读通道（query）出现 MongoDB 写操作 ${head}，需要确认` };
    return { level: 'warning', reason: `MongoDB 写操作 ${head} 将修改数据` };
  }
  if (MONGO_READ_OPS.has(head)) return { level: 'none' };
  if (op === 'query') return { level: 'danger', reason: `只读通道（query）出现未识别的 MongoDB 操作（${head}），需要确认` };
  // fail-closed：未识别的操作在 execute 通道也不静默放行（与 SQL/Redis 未识别语义对齐）
  return { level: 'warning', reason: `未识别的 MongoDB 操作（${head}），请确认后执行` };
}

/* ---------------- ChallengeStore ---------------- */

export interface Challenge {
  id: string;
  statementHash: string;
  createdAt: number;
  expiresAt: number;
  /** 绑定作用域：challenge 只能在同一连接+项目上消费，防跨库重放 */
  connId?: string;
  projectKey?: string;
}

/** challenge 的作用域（创建时绑定，消费时必须一致） */
export interface ChallengeScope {
  connId: string;
  projectKey: string;
}

export interface ChallengeStoreOptions {
  /** TTL 毫秒，默认 5min */
  ttlMs?: number;
  /** 注入时钟（测试过期） */
  now?: () => number;
  /** 清理周期毫秒，默认 60s；传 0 禁用定时器（测试用） */
  sweepIntervalMs?: number;
}

/**
 * 一次性确认凭据：绑定语句 SHA256、5 分钟过期、定期清理。
 * consume(id, statement)：存在 + 未过期 + hash 一致才通过，且立即失效（一次性）。
 */
export class ChallengeStore {
  private readonly ttl: number;
  private readonly nowFn: () => number;
  private readonly map = new Map<string, Challenge>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(opts?: ChallengeStoreOptions) {
    this.ttl = opts?.ttlMs ?? 5 * 60 * 1000;
    this.nowFn = opts?.now ?? (() => Date.now());
    const interval = opts?.sweepIntervalMs ?? 60 * 1000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref?.();
    }
  }

  /** 生成绑定语句+作用域的一次性 challenge */
  create(statement: string, scope?: ChallengeScope): Challenge {
    if (this.disposed) throw new Error('ChallengeStore 已关闭');
    const now = this.nowFn();
    const ch: Challenge = {
      id: 'c_' + randomBytes(12).toString('hex'),
      statementHash: statementHash(statement),
      createdAt: now,
      expiresAt: now + this.ttl,
      ...(scope ? { connId: scope.connId, projectKey: scope.projectKey } : {}),
    };
    this.map.set(ch.id, ch);
    return ch;
  }

  /** 一次性消费：存在 + 未过期 + hash 与作用域一致才通过，且立即失效；否则 false（不改状态） */
  consume(id: string, statement: string, scope?: ChallengeScope): boolean {
    const ch = this.map.get(id);
    if (!ch) return false;
    this.map.delete(id); // 无论成败都取走，防重放探测
    if (this.nowFn() > ch.expiresAt) return false;
    if (ch.statementHash !== statementHash(statement)) return false;
    // 作用域绑定：创建时带 scope 则消费时必须完全一致（防同语句跨连接/跨项目重放）
    if (ch.connId !== undefined && ch.connId !== scope?.connId) return false;
    if (ch.projectKey !== undefined && ch.projectKey !== scope?.projectKey) return false;
    return true;
  }

  /** 清理过期项 */
  sweep(): void {
    const now = this.nowFn();
    for (const [id, ch] of this.map) {
      if (now > ch.expiresAt) this.map.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.map.clear();
  }
}
