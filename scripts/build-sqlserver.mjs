#!/usr/bin/env node
/**
 * 构建 vendor/sqlserver-driver.cjs：把 mssql（含 tedious）驱动 bundle 成单文件。
 *
 * 背景与 mongodb 同因（见 scripts/build-mongodb.mjs 头注释）：DSH 宿主
 * @deepseek-ai/dsh-app-boot（<= 0.1.7-rc.2）加载插件时对依赖树逐包调
 * `require.resolve.paths(name)` 且不防护 null → 核心模块同名包会让整个插件无法加载。
 * mssql → tedious → bl → readable-stream 链会引入 buffer / events / process /
 * string_decoder 四个核心模块同名包，因此 mssql 只作 devDependency（提供 bundle 源与
 * 类型），生产依赖树里不出现它。
 *
 * 不能把 @azure/identity、@azure/core-auth external 掉：tedious/lib/connection.js 顶部是
 * 静态 require（非惰性），缺失会直接 MODULE_NOT_FOUND，故一并内联。
 * msnodesqlv8 是 Windows 集成认证的独立入口（mssql/msnodesqlv8.js），不在主入口依赖链上，
 * 保留为 external 以防驱动内部试探性 require。
 *
 * 每次执行全量重建（esbuild 秒级），不做幂等跳过，避免「源升级产物旧」。
 */
import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'vendor', 'sqlserver-driver.cjs');

/** msnodesqlv8 为可选原生驱动（本项目不支持 Windows 集成认证），不需要内联 */
const externals = ['msnodesqlv8'];

const entry = path.join(root, 'node_modules', 'mssql', 'index.js');
if (!statSync(entry, { throwIfNoEntry: false })) {
  console.error('[build-sqlserver] 未找到 node_modules/mssql/index.js —— 请先 npm install（mssql 在 devDependencies，提供 bundle 源）');
  process.exit(1);
}

mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: externals,
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

const size = statSync(outfile).size;
console.log(`[build-sqlserver] wrote vendor/sqlserver-driver.cjs (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log('[build-sqlserver] done');
