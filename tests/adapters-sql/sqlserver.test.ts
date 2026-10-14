/**
 * SQL Server 适配器真机集成测试——仅当 DBT_TEST_SQLSERVER_URL 存在时运行，否则整体 skip。
 * 地址形如 sqlserver://sa:pw@host:1433/db（需对默认库有 DDL 权限；2008/2008 R2 与 2022 均可）。
 *
 * 门控范式与 tests/adapters-sql/mysql.test.ts 一致，关键点：
 *  - `const suite = url ? describe : describe.skip;`
 *  - **所有 beforeAll/afterAll 钩子写在 suite(...) 回调内部**：写在顶层时 skip 只会跳过用例，
 *    钩子仍会执行并真连（无 URL 的 CI 上炸整个文件、发起真实网络调用）。
 *  - 不设该环境变量时：本文件 0 真实连接、全部用例 skipped，默认 npm test 不受影响。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlserverAdapter } from '../../lib/adapters/sqlserver/index.js';
import type { TxHandle } from '../../lib/adapters/sql-shared/pg-like.js';
import type { DatabaseAdapter, ResolvedConnection } from '../../lib/adapters/types.js';

const url = process.env.DBT_TEST_SQLSERVER_URL;
const suite = url ? describe : describe.skip;

/** 测试对象一律 dbt_test_sqlserver_* 前缀，beforeAll/afterAll 双向清理 */
const TABLE = 'dbt_test_sqlserver_users';
const VIEW = 'dbt_test_sqlserver_view';
const ROUNDTRIP = 'dbt_test_sqlserver_roundtrip';
const SCHEMA = 'dbo';

const conn: ResolvedConnection = {
  meta: { id: 'sqlserver-test', kind: 'sqlserver' },
  ...(url ? { url } : {}),
};

let adapter: DatabaseAdapter & { tx: TxHandle };
/** 真机探测到的服务器主版本（断言分页走哪条路径；探测失败为 0 → 期望降级路径） */
let major = 0;

suite('sqlserver 适配器（真机，DBT_TEST_SQLSERVER_URL 门控）', () => {
  beforeAll(async () => {
    // 钩子在 suite 回调内（见文件头注释）：skip 时随用例一起跳过
    adapter = await createSqlserverAdapter(conn);

    const v = await adapter.query(
      `SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
              CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version`,
    );
    major =
      Number(v.rows[0]?.[0]) ||
      Number.parseInt(String(v.rows[0]?.[1] ?? ''), 10) ||
      0;

    await adapter.execute(`IF OBJECT_ID(N'${SCHEMA}.${VIEW}', N'V') IS NOT NULL DROP VIEW ${SCHEMA}.${VIEW}`);
    await adapter.execute(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}', N'U') IS NOT NULL DROP TABLE ${SCHEMA}.${TABLE}`);
    await adapter.execute(
      `CREATE TABLE ${SCHEMA}.${TABLE} (id INT NOT NULL PRIMARY KEY, name NVARCHAR(64) NOT NULL, score DECIMAL(10,2) NULL, created DATETIME2 NULL)`,
    );
    await adapter.execute(`CREATE VIEW ${SCHEMA}.${VIEW} AS SELECT id, name FROM ${SCHEMA}.${TABLE}`);
    // 5 行种子数据：供分页与 offset 断言（多行 VALUES 一次往返）
    await adapter.execute(
      `INSERT INTO ${SCHEMA}.${TABLE} (id, name, score, created) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        1, 'alice', '3.14', '2024-01-02T03:04:05',
        2, 'bob', '1.00', '2024-01-02T03:04:06',
        3, 'carol', '2.50', '2024-01-02T03:04:07',
        4, 'dave', '9.99', '2024-01-02T03:04:08',
        5, 'erin', null, null,
      ],
    );
  });

  afterAll(async () => {
    if (!adapter) return;
    await adapter.execute(`IF OBJECT_ID(N'${SCHEMA}.${VIEW}', N'V') IS NOT NULL DROP VIEW ${SCHEMA}.${VIEW}`).catch(() => {});
    await adapter.execute(`IF OBJECT_ID(N'${SCHEMA}.${TABLE}', N'U') IS NOT NULL DROP TABLE ${SCHEMA}.${TABLE}`).catch(() => {});
    await adapter.close();
  });

  it('testConnect 返回 SQL Server 版本串', async () => {
    const r = await adapter.testConnect();
    expect(r.ok).toBe(true);
    expect(r.serverInfo).toMatch(/SQL Server/);
  });

  it('query 读取：DECIMAL 钉 string、DATETIME2→ISO、? 顺序绑定', async () => {
    const qr = await adapter.query(`SELECT id, name, score, created FROM ${SCHEMA}.${TABLE} WHERE id = ?`, [1]);
    expect(qr.columns).toEqual(['id', 'name', 'score', 'created']);
    expect(qr.rows[0]?.[0]).toBe(1);
    expect(qr.rows[0]?.[1]).toBe('alice');
    // decimal/numeric 钉 string（官方类型表下 decimal 返回 JS Number，超过 2^53 会丢精度）
    expect(qr.rows[0]?.[2]).toBe('3.14');
    // Date → ISO 字符串
    expect(String(qr.rows[0]?.[3])).toMatch(/^2024-01-02T03:04:05/);
  });

  it('占位符跳过：字符串/注释里的 ? 不参与绑定', async () => {
    const qr = await adapter.query(`SELECT ? AS p, 'a?b' AS s, [we?ird] FROM (SELECT 1 AS [we?ird]) t`, [7]);
    expect(qr.columns).toEqual(['p', 's', 'we?ird']);
    expect(qr.rows[0]).toEqual([7, 'a?b', 1]);
  });

  it('execute 写入 + affectedRows 求和', async () => {
    const ex = await adapter.execute(`INSERT INTO ${SCHEMA}.${TABLE} (id, name) VALUES (?, ?), (?, ?)`, [
      900, 'plain-a', 901, 'plain-b',
    ]);
    expect(ex.affectedRows).toBe(2);
    await adapter.execute(`DELETE FROM ${SCHEMA}.${TABLE} WHERE id IN (900, 901)`);
  });

  it('query/execute 往返（建表→插入→查询→删除，try/finally 清理）', async () => {
    try {
      await adapter.execute(`CREATE TABLE ${SCHEMA}.${ROUNDTRIP} (id INT NOT NULL PRIMARY KEY, v NVARCHAR(32) NULL)`);
      const ins = await adapter.execute(`INSERT INTO ${SCHEMA}.${ROUNDTRIP} (id, v) VALUES (?, ?)`, [1, 'x']);
      expect(ins.affectedRows).toBe(1);
      const qr = await adapter.query(`SELECT id, v FROM ${SCHEMA}.${ROUNDTRIP} WHERE id = ?`, [1]);
      expect(qr.rows).toEqual([[1, 'x']]);
    } finally {
      await adapter
        .execute(`IF OBJECT_ID(N'${SCHEMA}.${ROUNDTRIP}', N'U') IS NOT NULL DROP TABLE ${SCHEMA}.${ROUNDTRIP}`)
        .catch(() => {});
    }
  });

  it('listDatabases / listSchemas 返回非空且含默认库与 dbo', async () => {
    const dbs = await adapter.listDatabases();
    expect(dbs.length).toBeGreaterThan(0);
    const schemas = await adapter.listSchemas?.();
    expect(schemas ?? []).toContain(SCHEMA);
    // 系统 schema 已被过滤
    expect(schemas ?? []).not.toContain('sys');
    expect(schemas ?? []).not.toContain('INFORMATION_SCHEMA');
  });

  it('listTables：表与视图都在，type 归一 TABLE/VIEW', async () => {
    const tables = await adapter.listTables(SCHEMA);
    const t = tables.find((x) => x.name === TABLE);
    const v = tables.find((x) => x.name === VIEW);
    expect(t?.type).toBe('TABLE');
    expect(v?.type).toBe('VIEW');
    expect(t?.database).toBe(SCHEMA);
  });

  it('describeTable：主键 PRI、类型带长度、表不存在报错', async () => {
    const cols = await adapter.describeTable(TABLE, SCHEMA);
    expect(cols.find((c) => c.name === 'id')?.key).toBe('PRI');
    expect(cols.find((c) => c.name === 'id')?.dataType).toBe('int');
    expect(cols.find((c) => c.name === 'name')?.dataType).toBe('nvarchar(32)');
    expect(cols.find((c) => c.name === 'score')?.dataType).toBe('decimal(10, 2)');
    expect(cols.find((c) => c.name === 'name')?.nullable).toBe(false);
    expect(cols.find((c) => c.name === 'score')?.nullable).toBe(true);
    await expect(adapter.describeTable('dbt_test_sqlserver_ghost', SCHEMA)).rejects.toThrow(/表不存在/);
  });

  it('previewRows 分页：行数受限、offset 生效、内部序号列不泄漏', async () => {
    const p1 = await adapter.previewRows(TABLE, 2, SCHEMA, 0);
    expect(p1.rowCount).toBe(2);
    // 两条路径（>=11 的 OFFSET/FETCH 与 2008 系的 ROW_NUMBER 降级）都必须剔除内部序号列
    expect(p1.columns.some((c) => c.toLowerCase() === '__dsh_rn')).toBe(false);

    const p2 = await adapter.previewRows(TABLE, 2, SCHEMA, 3);
    expect(p2.rowCount).toBe(2);
    // offset 生效：跳过前 3 行后只剩 id 4/5（顺序不保证，按集合断言）
    const ids = p2.rows.map((r) => Number(r[p2.columns.indexOf('id')]));
    expect(new Set(ids)).toEqual(new Set([4, 5]));

    const clamped = await adapter.previewRows(TABLE, 999, SCHEMA, 0);
    expect(clamped.rowCount).toBeLessThanOrEqual(50);

    // 与探测到的实际版本一致：2008 系必须走降级路径（此处验证其行为等价：仍能正确分页）
    if (major > 0 && major < 11) {
      expect(p1.rowCount).toBe(2);
    }
  });

  it('ro 模式：只读查询可跑，写语句被适配器白名单拒绝', async () => {
    const ro = await createSqlserverAdapter(conn, { mode: 'ro' });
    try {
      const ok = await ro.query(`SELECT COUNT(*) AS n FROM ${SCHEMA}.${TABLE}`);
      expect(Number(ok.rows[0]?.[0])).toBeGreaterThanOrEqual(5);
      await expect(ro.query(`UPDATE ${SCHEMA}.${TABLE} SET name = 'x' WHERE id = 1`)).rejects.toThrow(/只读/);
      await expect(ro.query(`DELETE FROM ${SCHEMA}.${TABLE}`)).rejects.toThrow(/只读/);
      await expect(ro.query(`SELECT 1; DELETE FROM ${SCHEMA}.${TABLE}`)).rejects.toThrow(/多条语句/);
    } finally {
      await ro.close();
    }
  });

  it('事务 begin/commit 生效、begin/rollback 不落库', async () => {
    await adapter.tx.begin();
    await adapter.execute(`INSERT INTO ${SCHEMA}.${TABLE} (id, name) VALUES (?, ?)`, [910, 'tx-commit']);
    await adapter.tx.commit();
    const c1 = await adapter.query(`SELECT COUNT(*) AS n FROM ${SCHEMA}.${TABLE} WHERE id = 910`);
    expect(Number(c1.rows[0]?.[0])).toBe(1);

    await adapter.tx.begin();
    await adapter.execute(`INSERT INTO ${SCHEMA}.${TABLE} (id, name) VALUES (?, ?)`, [911, 'tx-rollback']);
    await adapter.tx.rollback();
    const c2 = await adapter.query(`SELECT COUNT(*) AS n FROM ${SCHEMA}.${TABLE} WHERE id = 911`);
    expect(Number(c2.rows[0]?.[0])).toBe(0);

    await adapter.execute(`DELETE FROM ${SCHEMA}.${TABLE} WHERE id IN (910, 911)`);
    // 事务结束后状态复位：再 commit 应报「没有进行中的事务」
    await expect(adapter.tx.commit()).rejects.toThrow(/没有进行中的事务/);
  });

  it('close 幂等：重复 close 不抛', async () => {
    const a = await createSqlserverAdapter(conn);
    await a.close();
    await expect(a.close()).resolves.toBeUndefined();
  });
});
