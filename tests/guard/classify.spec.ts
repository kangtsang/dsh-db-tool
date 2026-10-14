/** classifyStatement 全 kind 分级用例 + statementHash 稳定性 */
import { describe, expect, it } from 'vitest';
import { classifyStatement, sqlHead, statementHash } from '../../lib/guard/index.js';

describe('classifyStatement: SQL 系', () => {
  it('普通 SELECT 为 none', () => {
    expect(classifyStatement('mysql', 'SELECT * FROM users', 'query')).toMatchObject({ level: 'none' });
    expect(classifyStatement('oracle', 'explain plan for select 1', 'execute')).toMatchObject({ level: 'none' });
  });

  it('DDL 为 danger，原因是 DDL 不可回滚', () => {
    for (const stmt of ['DROP TABLE users', 'truncate table t', 'ALTER TABLE users ADD c int', 'drop database app']) {
      const v = classifyStatement('mysql', stmt, 'execute');
      expect(v.level).toBe('danger');
      expect(v.reason).toContain('不可回滚');
    }
  });

  it('DML 在 execute 通道为 warning，在 query 通道为 danger', () => {
    expect(classifyStatement('postgresql', 'UPDATE users SET a=1', 'execute').level).toBe('warning');
    expect(classifyStatement('postgresql', 'DELETE FROM users', 'query').level).toBe('danger');
    expect(classifyStatement('sqlite', 'INSERT INTO t VALUES (1)', 'execute').level).toBe('warning');
  });

  it('读语句内的危险片段升级为 danger', () => {
    for (const stmt of [
      'SELECT 1; DROP TABLE users',
      "SELECT * FROM t INTO OUTFILE '/tmp/x'",
      'SET GLOBAL max_connections=100',
    ]) {
      expect(classifyStatement('mysql', stmt, 'query').level).toBe('danger');
    }
  });

  it('维护命令为 danger', () => {
    expect(classifyStatement('mysql', 'FLUSH PRIVILEGES', 'execute').level).toBe('danger');
    expect(classifyStatement('mysql', 'KILL 12', 'execute').level).toBe('danger');
  });

  it('未知关键字：query 通道 danger，execute 通道 warning', () => {
    expect(classifyStatement('mysql', 'ADMINISH THINGS', 'query').level).toBe('danger');
    expect(classifyStatement('mysql', 'ADMINISH THINGS', 'execute').level).toBe('warning');
  });
});

describe('sqlHead 白盒：注释剥离与首词提取', () => {
  it('注释剥离行为：跨行块注释、防粘连、行注释吃满、空输入', () => {
    expect(sqlHead('/* multi\nline */ SELECT 1')).toBe('select'); // 跨行块注释完整剥离
    expect(sqlHead('sele/*x*/ct')).toBe('sele'); // 剥离替换为空格，'sele'/'ct' 不粘连成 'select'
    expect(sqlHead('SET--update a=1')).toBe('set'); // -- 注释吃到行尾
    expect(sqlHead('SET#update a=1')).toBe('set');
    expect(sqlHead('')).toBe('');
    expect(sqlHead('/* 只有注释 */')).toBe('');
    expect(sqlHead('123 numbers')).toBe('');
  });
});

describe('classifyStatement: SQL 注释剥离', () => {
  it('块注释剥离用于首词提取：剥离后首词正确（含跨行注释）', () => {
    expect(classifyStatement('mysql', '/* multi\nline */ SELECT 1', 'query').level).toBe('none');
    expect(classifyStatement('mysql', 'SELECT/*x*/1', 'query').level).toBe('none');
  });

  it('注释内写词不触发语句体扫描（body 基于剥注释文本，消除误报）', () => {
    const v = classifyStatement('mysql', 'SELECT /* DROP TABLE users */ 1', 'query');
    expect(v.level).toBe('none');
    expect(classifyStatement('mysql', 'SELECT 1 /* drop */', 'query').level).toBe('none');
    // SET 是白名单读头：剥注释后 'SET' 无写词 → none（注释里藏的 update 不再误报）
    expect(classifyStatement('mysql', 'SET--update a=1', 'query').level).toBe('none');
    expect(classifyStatement('mysql', 'SET#update a=1', 'query').level).toBe('none');
  });

  it('前导块注释不使 DDL 漏判（/* x */ DROP 按危险语句确认，堵绕过）', () => {
    const v = classifyStatement('mysql', '/* 注释 */ DROP TABLE users', 'execute');
    expect(v.level).toBe('danger');
    expect(v.reason).toContain('DDL');
    expect(classifyStatement('mysql', '/* 注释 */ DELETE FROM t', 'execute').level).toBe('warning');
    expect(classifyStatement('mysql', '/* 注释 */ DROP TABLE users', 'query').level).toBe('danger');
  });

  it('WITH CTE 语句体中的写词扫描为 danger', () => {
    expect(classifyStatement('mysql', 'WITH x AS (SELECT 1) DELETE FROM t', 'query').level).toBe('danger');
  });

  it('行注释（-- 与 #）剥离：行首注释不破坏首词提取', () => {
    expect(classifyStatement('mysql', '-- c\nSELECT 1', 'query').level).toBe('none');
    expect(classifyStatement('mysql', '# c\nSELECT 1', 'query').level).toBe('none');
    // 行尾注释内写词不触发 body 扫描（剥注释后为纯 SELECT）
    expect(classifyStatement('mysql', 'SELECT 1 -- DROP TABLE x', 'query').level).toBe('none');
  });

  it('首词提取容忍前导空白与括号', () => {
    expect(classifyStatement('mysql', '  SELECT 1', 'query').level).toBe('none');
    expect(classifyStatement('mysql', '(( select 1', 'query').level).toBe('none');
  });

  it('无法提取首词时 fail-closed 为 danger', () => {
    const v = classifyStatement('mysql', '123 numbers', 'query');
    expect(v.level).toBe('danger');
    expect(v.reason).toContain('无法解析语句关键字');
  });
});

describe('classifyStatement: SQL Server（T-SQL 专属危险语句）', () => {
  it('备份/还原/DBCC/实例配置/扩展存储过程：execute 通道也不降级为 warning', () => {
    for (const stmt of [
      "BACKUP DATABASE app TO DISK = 'C:\\bak\\app.bak'",
      "BACKUP LOG app TO DISK = 'C:\\bak\\app.trn'",
      "RESTORE DATABASE app FROM DISK = 'C:\\bak\\app.bak'",
      'DBCC CHECKDB (app)',
      'DBCC SHRINKDATABASE (app)',
      'RECONFIGURE',
      "sp_configure 'xp_cmdshell', 1",
      "EXEC sp_configure 'show advanced options', 1",
      "EXEC xp_cmdshell 'dir C:\\'",
      "EXECUTE master..xp_cmdshell 'whoami'",
      "EXEC @rc = master.dbo.xp_cmdshell 'whoami'",
      "xp_cmdshell 'dir'",
      'SHUTDOWN WITH NOWAIT',
      "BULK INSERT dbo.t FROM 'C:\\data.csv'",
    ]) {
      const v = classifyStatement('sqlserver', stmt, 'execute');
      expect(v.level, stmt).toBe('danger');
    }
  });

  it('只读通道（query）同样 danger', () => {
    expect(classifyStatement('sqlserver', "BACKUP DATABASE app TO DISK = 'x'", 'query').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'DBCC CHECKDB', 'query').level).toBe('danger');
  });

  it('普通语句沿用通用口径：专属表不误伤 SELECT/普通存储过程/一般 EXEC', () => {
    expect(classifyStatement('sqlserver', 'SELECT * FROM users', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT TOP 10 [name] FROM [dbo].[t]', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'INSERT INTO t (a) VALUES (1)', 'execute').level).toBe('warning');
    expect(classifyStatement('sqlserver', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'execute').level).toBe('warning');
    expect(classifyStatement('sqlserver', 'DROP TABLE t', 'execute').level).toBe('danger');
    // 一般 EXEC dbo.usp_* 不属于扩展过程清单：保持未识别 warning，不因 sqlserver 专属表被判 danger
    expect(classifyStatement('sqlserver', 'EXEC dbo.usp_get_users', 'execute').level).toBe('warning');
  });

  it('SELECT ... INTO 建表副作用判 danger（T-SQL 独有，通用正则的 into 只认 OUTFILE/DUMPFILE）', () => {
    expect(classifyStatement('sqlserver', 'SELECT * INTO dbo.newtbl FROM t', 'execute').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'SELECT TOP 100 col INTO #tmp FROM t', 'query').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'WITH x AS (SELECT 1 AS a) SELECT * INTO dbo.newtbl FROM x', 'execute').level).toBe('danger');
  });

  it('CTE 内写操作判 danger（WITH ... DELETE/UPDATE/INSERT）', () => {
    expect(classifyStatement('sqlserver', 'WITH x AS (SELECT 1 AS a) DELETE FROM dbo.t', 'execute').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'WITH x AS (SELECT 1 AS a) UPDATE dbo.t SET a = 1', 'execute').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'WITH x AS (SELECT 1 AS a) INSERT INTO dbo.t (a) SELECT a FROM x', 'execute').level).toBe('danger');
  });

  it('字符串/带引号标识符内的 INTO 不误报；INTO @ 变量赋值放行；INSERT INTO 口径不变', () => {
    expect(classifyStatement('sqlserver', "SELECT 'into tbl' AS a", 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT [into] FROM t', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT "into" FROM t', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', "SELECT * FROM t WHERE c = 'INTO x'", 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT 1 INTO @t', 'query').level).toBe('none');
    // 剥字面量后不得把 INSERT INTO 误当 SELECT INTO（DML 口径保持 warning）
    expect(classifyStatement('sqlserver', 'INSERT INTO dbo.t (a) VALUES (1)', 'execute').level).toBe('warning');
  });

  it('EXEC 动态 SQL（括号/字符串/变量）与 sp_executesql 一律 danger；只读系统过程不误报', () => {
    for (const s of [
      "EXEC('DROP TABLE t')",
      "EXEC ( 'DROP TABLE t' )",
      "EXEC N'DROP TABLE t'",
      "EXEC sp_executesql N'DROP TABLE t'",
      "EXEC('xp_cmdshell ''whoami''')",
      "EXEC('BACKUP DATABASE db TO DISK=''c:\\x.bak''')",
      'EXEC @sql',
      'EXECUTE(@sql)',
      "SELECT * FROM OPENQUERY(ls,'EXEC xp_cmdshell ''whoami''')",
    ]) {
      const v = classifyStatement('sqlserver', s, 'execute');
      expect(v.level, s).toBe('danger');
    }
    // 对照：只读系统过程 / 普通存储过程 / 普通读不因动态 SQL 规则误报（仍是未识别 warning，不是 danger）
    expect(classifyStatement('sqlserver', 'EXEC sp_who', 'execute').level).toBe('warning');
    expect(classifyStatement('sqlserver', 'EXEC dbo.usp_get_users', 'execute').level).toBe('warning');
    expect(classifyStatement('sqlserver', 'SELECT 1', 'query').level).toBe('none');
  });

  it('SELECT ... INTO 收紧：AS 列别名/变量赋值不误判；真建表仍 danger', () => {
    expect(classifyStatement('sqlserver', 'SELECT 1 AS into FROM t', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT 1 as\ninto FROM t', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT a FROM t ORDER BY x', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT 1 INTO @t', 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', 'SELECT * INTO dbo.newtbl FROM t', 'query').level).toBe('danger');
    expect(classifyStatement('sqlserver', 'SELECT [a]]b] INTO t2 FROM t', 'query').level).toBe('danger');
  });

  it('WITH + 写操作：理由指向写操作，不误挂 SELECT INTO', () => {
    const v = classifyStatement('sqlserver', 'WITH c AS (SELECT 1 AS n) INSERT INTO t SELECT * FROM c', 'execute');
    expect(v.level).toBe('danger');
    expect(v.reason ?? '').not.toMatch(/SELECT \.\.\. INTO/);
    expect(v.reason ?? '').toMatch(/写操作/);
  });

  it('远端字符串内的写关键字不误报，但其中动态 EXEC/xp_ 判危；多语句仍拦', () => {
    expect(classifyStatement('sqlserver', "SELECT * FROM OPENQUERY(ls,'DELETE FROM t')", 'query').level).toBe('none');
    expect(classifyStatement('sqlserver', "SELECT 'DROP TABLE t' AS msg", 'query').level).toBe('none');
    // 多语句/未闭合字面量里的第二条语句沿用原文判定（不被剥字面量吞掉）
    expect(classifyStatement('sqlserver', "SELECT 'a''; DROP TABLE t", 'query').level).toBe('danger');
    expect(classifyStatement('sqlserver', "SELECT * FROM OPENQUERY(ls,'EXEC xp_cmdshell ''whoami''')", 'query').level).toBe('danger');
  });

  it('专属表只对 sqlserver 生效：BACKUP/DBCC 在其它 kind 仍走既有未识别口径', () => {
    expect(classifyStatement('mysql', "BACKUP DATABASE x TO DISK = 'y'", 'execute').level).toBe('warning');
    expect(classifyStatement('mysql', 'DBCC CHECKDB', 'execute').level).toBe('warning');
    expect(classifyStatement('postgresql', 'BACKUP DATABASE x', 'execute').level).toBe('warning');
  });
});

describe('classifyStatement: Redis', () => {
  it('危险命令 danger（13 项清单）', () => {
    expect(classifyStatement('redis', 'FLUSHALL', 'execute').level).toBe('danger');
    expect(classifyStatement('redis', 'config get maxmemory', 'query').level).toBe('danger');
    expect(classifyStatement('redis', 'keys *', 'query').level).toBe('danger');
  });

  it('读命令 none、写命令 warning', () => {
    expect(classifyStatement('redis', 'GET key', 'query').level).toBe('none');
    expect(classifyStatement('redis', 'SET key v', 'execute').level).toBe('warning');
  });

  it('JSON 数组形式同样解析', () => {
    expect(classifyStatement('redis', '["FLUSHDB"]', 'execute').level).toBe('danger');
    expect(classifyStatement('redis', '["GET","key"]', 'query').level).toBe('none');
  });

  it('未知命令 fail-closed：query 通道 danger、execute 通道 warning', () => {
    expect(classifyStatement('redis', 'WHATCOMMAND a b', 'query').level).toBe('danger');
    expect(classifyStatement('redis', 'WHATCOMMAND a b', 'execute').level).toBe('warning');
  });
});

describe('classifyStatement: MongoDB', () => {
  it('危险操作 danger（8 项清单）', () => {
    expect(classifyStatement('mongodb', '{"dropDatabase":1}', 'execute').level).toBe('danger');
    expect(classifyStatement('mongodb', '{"dropCollection":"users"}', 'execute').level).toBe('danger');
    expect(classifyStatement('mongodb', '{"deleteMany":{"filter":{}}}', 'execute').level).toBe('danger');
  });

  it('写操作 warning、读操作 none', () => {
    expect(classifyStatement('mongodb', '{"insert":"users","documents":[]}', 'execute').level).toBe('warning');
    expect(classifyStatement('mongodb', '{"find":"users","filter":{}}', 'query').level).toBe('none');
  });

  it('非法 JSON danger', () => {
    expect(classifyStatement('mongodb', 'not json at all', 'query').level).toBe('danger');
  });

  it('命令文档形式：drop 为 danger（等同 dropCollection），delete/update/create 为 warning', () => {
    const drop = classifyStatement('mongodb', '{"drop":"users"}', 'execute');
    expect(drop.level).toBe('danger');
    expect(drop.reason).toContain('dropCollection');
    for (const op of ['delete', 'update', 'create', 'insert']) {
      expect(classifyStatement('mongodb', `{"${op}":"t"}`, 'execute').level).toBe('warning');
    }
    expect(classifyStatement('mongodb', '{"drop":"users"}', 'query').level).toBe('danger');
  });

  it('未识别操作 fail-closed：execute 通道 warning（不得为 none）、query 通道 danger', () => {
    const v = classifyStatement('mongodb', '{"unknownOp":1}', 'execute');
    expect(v.level).toBe('warning');
    expect(v.reason).toContain('未识别的 MongoDB 操作');
    expect(classifyStatement('mongodb', '{"unknownOp":1}', 'query').level).toBe('danger');
  });
});

describe('statementHash', () => {
  it('trim 后哈希，稳定一致', () => {
    expect(statementHash('DROP TABLE users')).toBe(statementHash('  DROP TABLE users  '));
    expect(statementHash('DROP TABLE users')).not.toBe(statementHash('DROP TABLE users2'));
  });
});
