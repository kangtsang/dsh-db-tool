/**
 * MySQL 适配器（mysql2/promise）。
 * query=读用 pool.query()；execute=写用 pool.execute()（真 prepare，占位符 ?）。
 * DECIMAL 官方默认 string 保持；dateStrings:true 使 DATE/DATETIME 直接输出字符串。
 * ro 模式：multipleStatements 固定 false（防堆叠注入）；建连后会话级只读（SET SESSION
 * TRANSACTION READ ONLY）+ query 首词只读白名单双保险；服务层拦截 execute。
 */
import mysql, {
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type {
  AccessMode,
  AdapterFactory,
  ColumnInfo,
  DatabaseAdapter,
  ExecResult,
  QueryResult,
  ResolvedConnection,
  TableInfo,
} from '../types.js';
import { assertIdent, clampLimit, clampOffset, humanize, normalizeCell, quoteIdent, validPort } from '../sql-shared/common.js';
import type { TxHandle } from '../sql-shared/pg-like.js';

/** ro 模式下 query 允许的读语句首词白名单 */
const RO_READ_PREFIX = /^(select|show|desc|describe|explain|use|help|table)\b/i;

/**
 * 吞掉 'connection' 回调里会话级 SET 的失败（ro / time_zone 仅是增强，失败不应拖垮连接与进程）。
 * mysql2 promise 池的 'connection' 事件由核心池 emit、经 lib/promise/inherit_events.js
 * 原样转发参数，回调收到的是 callback 版 PoolConnection：其 query() 返回 Query 命令
 * 对象（EventEmitter，无 onResult 时错误走 emit('error')，lib/commands/command.js），
 * 无监听会抛 uncaughtException 崩溃进程——.catch 防御对它恒不生效，必须挂 error 监听。
 * 若驱动版本改为返回 Promise，则走 .catch 吞 rejection（双分支防御）。
 */
function swallowSetError(r: unknown): void {
  if (r && typeof (r as Promise<unknown>).catch === 'function') {
    void (r as Promise<unknown>).catch(() => {});
    return;
  }
  if (r && typeof (r as NodeJS.EventEmitter).on === 'function') {
    (r as NodeJS.EventEmitter).on('error', () => {});
  }
}

function connOptions(conn: ResolvedConnection): mysql.PoolOptions {
  const base: mysql.PoolOptions = {
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    multipleStatements: false,
    dateStrings: true,
    connectTimeout: 10000,
    charset: 'utf8mb4_general_ci',
  };
  if (conn.url) {
    const u = new URL(conn.url);
    base.host = u.hostname;
    // 端口段校验：':0' 等非法值抛中文错误，不再被 Number()|| 静默改写 3306
    base.port = u.port ? validPort(u.port, 3306, 'mysql') : 3306;
    try {
      if (u.username) base.user = decodeURIComponent(u.username);
      if (u.password) base.password = decodeURIComponent(u.password);
    } catch {
      throw new Error('mysql 连接 URL 的用户名或密码 percent 编码非法（如含未编码的 %），请 URL 编码后重试');
    }
    const db = u.pathname.replace(/^\//, '');
    if (db) base.database = db;
    const ssl = u.searchParams.get('ssl');
    if (conn.ssl || ssl === 'true' || ssl === 'require') base.ssl = { rejectUnauthorized: false };
  } else if (conn.fields) {
    const f = conn.fields;
    base.host = String(f.host ?? '127.0.0.1');
    // 前端原样发字符串端口：显式校验，NaN/0 等不再被驱动 `|| 3306` 静默改写后连错服务
    base.port = validPort(f.port, 3306, 'mysql');
    base.user = String(f.user ?? f.username ?? 'root');
    if (f.password != null) base.password = String(f.password);
    if (f.database != null) base.database = String(f.database);
    if (conn.ssl) base.ssl = { rejectUnauthorized: false };
  } else {
    throw new Error('mysql 连接缺少 url 或 fields 配置');
  }
  return base;
}

export async function createMysqlAdapter(
  conn: ResolvedConnection,
  opts?: { mode?: AccessMode },
): Promise<DatabaseAdapter & { tx: TxHandle }> {
  const baseOpts = connOptions(conn);
  const pool = mysql.createPool(baseOpts);
  const readOnly = opts?.mode === 'ro';

  // 跨库（Navicat 式）：按库名缓存独立池。mysql2 官方多库方案即多池管理——池上
  // changeUser/USE 只影响被调用的那条池内连接，池保持建池配置，切库不可靠。
  const mainDb = typeof baseOpts.database === 'string' ? baseOpts.database : '';
  const dbPools = new Map<string, mysql.Pool>();
  /**
   * 关闭幂等标志（对齐 pg-like/sqlserver）：关闭后一切访问必须被拦下——
   * 否则跨库访问会新建池（关不掉的连接泄漏），主池请求则报英文驱动错。
   */
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error('mysql 连接已关闭：请重新连接后重试');
  };

  /** ro 模式：每个新底层连接自动设为只读会话（应用层另有 query 白名单双保险）。
   *  回调收到的是 callback 版 PoolConnection，query() 返回 Query 命令对象（EventEmitter）：
   *  吞掉 SET 失败防 uncaughtException（见 swallowSetError）。主池与跨库池共用同一注册。 */
  const attachReadOnly = (p: mysql.Pool): void => {
    if (!readOnly) return;
    p.on('connection', (c) => {
      swallowSetError(c.query('SET SESSION TRANSACTION READ ONLY') as unknown);
    });
  };
  attachReadOnly(pool);

  const poolFor = (db: string): mysql.Pool => {
    assertOpen();
    if (db === mainDb) return pool;
    let p = dbPools.get(db);
    if (!p) {
      // connOptions 已把 URL/fields 拆成纯字段，覆盖 database 即建出目标库的池
      p = mysql.createPool({ ...baseOpts, database: db });
      dbPools.set(db, p);
      attachReadOnly(p);
    }
    return p;
  };

  /** 事务激活期间路由到同一连接，保证 BEGIN/COMMIT 生效 */
  let txConn: PoolConnection | null = null;
  // PoolConnection 与 Pool 的联合会让 mysql2 的 query/execute 重载解析失败，收窄为 Pool 视图
  const runner = (): Pool => (txConn ?? pool) as unknown as Pool;

  function toQueryResult(rows: RowDataPacket[], fields: FieldPacket[]): QueryResult {
    const columns = fields.map((f) => String(f.name));
    return {
      columns,
      rows: rows.map((r) => columns.map((c) => normalizeCell(r[c]))),
      rowCount: rows.length,
    };
  }

  const tx: TxHandle = {
    begin: () =>
      humanize('mysql 事务开启', async () => {
        if (txConn) throw new Error('事务已开启，请勿重复 begin');
        txConn = await pool.getConnection();
        try {
          await txConn.beginTransaction();
        } catch (e) {
          txConn.release();
          txConn = null;
          throw e;
        }
      }),
    commit: () =>
      humanize('mysql 事务提交', async () => {
        const c = txConn;
        if (!c) throw new Error('没有进行中的事务');
        txConn = null;
        try {
          await c.commit();
        } finally {
          c.release();
        }
      }),
    rollback: () =>
      humanize('mysql 事务回滚', async () => {
        const c = txConn;
        if (!c) throw new Error('没有进行中的事务');
        txConn = null;
        try {
          await c.rollback();
        } finally {
          c.release();
        }
      }),
  };

  const defaultDb = (): string => {
    let db = conn.fields?.database != null ? String(conn.fields.database) : '';
    if (!db && conn.url) {
      // URL 配置：默认库取 pathname 首段（与 connOptions 的解析一致）
      const p = new URL(conn.url).pathname.slice(1);
      if (p) db = p;
    }
    if (!db) throw new Error('未指定数据库：请传入 database 参数或配置默认库');
    // fields/URL 提供的库名统一过标识符校验（防注入）
    return assertIdent(db, '库名');
  };

  return {
    kind: 'mysql',
    connId: conn.meta.id,
    tx,

    testConnect: () =>
      humanize('mysql 连接测试', async () => {
        const [rows] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS v');
        return { ok: true, serverInfo: `MySQL ${String(rows[0]?.v ?? '')}` };
      }),

    query: (sql, params, database) =>
      humanize('mysql 查询失败', async () => {
        if (readOnly && !RO_READ_PREFIX.test(sql.trimStart())) {
          throw new Error(
            'DRIVER_ERROR: 只读(ro)模式下 query 仅允许读语句（select/show/desc/describe/explain/use/help/table），写操作请使用可写连接',
          );
        }
        // 跨库请求路由到该库自己的池（白名单校验在前，拒绝发生在建池之前；
        // 缺省判断用 != null：空串等非法值必须进 assertIdent 被拒，不能落回主池）；
        // 无 database 时维持事务粘主池语义（服务层已拒绝事务携带 database）
        const target = database != null ? poolFor(assertIdent(database, '库名')) : runner();
        const [rows, fields] = await target.query(sql, params ?? []);
        if (!Array.isArray(rows)) return { columns: [], rows: [], rowCount: 0 };
        return toQueryResult(rows as RowDataPacket[], fields);
      }),

    execute: (statement, params, database) =>
      humanize('mysql 执行失败', async (): Promise<ExecResult> => {
        // mysql2 的 ExecuteValues 不接受 unknown[]，此处值均为绑定参数（string|number|null）
        const target = database != null ? poolFor(assertIdent(database, '库名')) : runner();
        const [result] = await target.execute(statement, (params ?? []) as never[]);
        const header = (Array.isArray(result) ? result[0] : result) as
          | ResultSetHeader
          | undefined;
        const n = header?.affectedRows;
        return {
          affectedRows: typeof n === 'number' ? n : undefined,
          message:
            typeof n === 'number'
              ? `执行成功，受影响 ${n} 行`
              : '执行成功',
        };
      }),

    listDatabases: () =>
      humanize('mysql 列出数据库', async () => {
        const [rows] = await pool.query<RowDataPacket[]>(
          'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
        );
        return rows.map((r) => String(r.SCHEMA_NAME));
      }),

    listTables: (database) =>
      humanize('mysql 列出表', async () => {
        const db = database ? assertIdent(database, '库名') : defaultDb();
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
          [db],
        );
        return rows.map((r): TableInfo => {
          const rawType = String(r.TABLE_TYPE);
          const comment = r.TABLE_COMMENT;
          return {
            name: String(r.TABLE_NAME),
            type: rawType === 'BASE TABLE' ? 'TABLE' : rawType,
            comment: comment != null && comment !== '' ? String(comment) : undefined,
            database: db,
          };
        });
      }),

    describeTable: (table, database) =>
      humanize('mysql 查看表结构', async () => {
        const db = database ? assertIdent(database, '库名') : defaultDb();
        const tbl = assertIdent(table, '表名');
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [db, tbl],
        );
        if (rows.length === 0) throw new Error(`表不存在: ${db}.${tbl}`);
        return rows.map((r): ColumnInfo => {
          const dflt = r.COLUMN_DEFAULT;
          const comment = r.COLUMN_COMMENT;
          return {
            name: String(r.COLUMN_NAME),
            dataType: String(r.COLUMN_TYPE),
            nullable: r.IS_NULLABLE === 'YES',
            key: r.COLUMN_KEY ? String(r.COLUMN_KEY) : undefined,
            default: dflt == null ? null : String(dflt),
            comment: comment != null && comment !== '' ? String(comment) : undefined,
          };
        });
      }),

    previewRows: (table, limit, database, offset) =>
      humanize('mysql 预览行', async () => {
        const db = quoteIdent(database ? assertIdent(database, '库名') : defaultDb(), '`');
        const tbl = quoteIdent(assertIdent(table, '表名'), '`');
        const lim = clampLimit(limit);
        const off = clampOffset(offset);
        const [rows, fields] = await pool.query(
          `SELECT * FROM ${db}.${tbl} LIMIT ? OFFSET ?`,
          [lim, off],
        );
        if (!Array.isArray(rows)) return { columns: [], rows: [], rowCount: 0 };
        return toQueryResult(rows as RowDataPacket[], fields);
      }),

    close: () =>
      humanize('mysql 关闭连接', async () => {
        if (closed) return; // 幂等：重复 close 为 no-op（pg-pool 二次 end() 会抛的教训）
        closed = true;
        await Promise.all([pool.end(), ...[...dbPools.values()].map((p) => p.end())]);
      }),
  };
}

export const factory: AdapterFactory = (conn) => createMysqlAdapter(conn);

/**
 * 数据传输读端用的独立原始池（绕过 normalizeCell 保真搬运）。
 * dateStrings:true 保日期墙钟字符串；会话时区固定 UTC——TIMESTAMP 列（UTC 存储、
 * 按会话 time_zone 渲染）读出即 UTC 墙钟，作为 timestamptz 语义不随源服务器
 * time_zone 漂移（跨库传输会话时区抖动是静默偏移源，官方建议显式固定）。
 */
export interface MysqlRaw {
  pool: mysql.Pool;
  /** 连接解析出的默认库（mysql2 promise 池没有 .config，不能从池上反查） */
  database: string;
}

export async function openMysqlRaw(conn: ResolvedConnection): Promise<MysqlRaw> {
  const opts = connOptions(conn);
  const pool = mysql.createPool({ ...opts, dateStrings: true });
  // 回调式 query（带 err 回调吞错）。必须用回调式：非回调式返回的 Query 命令对象与
  // promise 池连接状态机冲突 → 该连接所有后续 query 永挂（真机实证 mysql2 3.24.4）
  pool.on('connection', (c) => {
    // 运行时 c 是 callback 版连接（promise 池类型标注不反映），按回调式调用
    (c.query as unknown as (sql: string, cb: (err: unknown) => void) => void)(
      "SET time_zone = '+00:00'",
      () => {},
    );
  });
  return { pool, database: typeof opts.database === 'string' ? opts.database : '' };
}
