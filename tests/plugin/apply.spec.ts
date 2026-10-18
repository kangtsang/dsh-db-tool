/**
 * 插件装配契约：inject 里只能出现宿主真实提供的服务。
 *
 * cordis 的 inject 是硬依赖：任一服务名在宿主上下文里不存在，fiber 就永久
 * pending，apply() 根本不执行——HTTP 路由不会注册，前端 fetch 拿到宿主
 * 兜底的 404（表现为「错误: HTTP 404」），且启动期只留一条 warning。
 *
 * 宿主 @deepseek-ai/dsh-web-app 提供的是 webApp，从不注册 webRuntime；
 * ssh-tunnel 因此把 webRuntime 排除在 inject 之外，用 ctx.get(name, true)
 * 可选读取。本文件锁住这两条。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { apply, inject } from '../../lib/index.js';

interface Route {
  kind: string;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void> | void;
}

function makeCtx(routes: Route[]): Record<string, unknown> {
  return {
    webServer: {
      register: (h: Route) => {
        routes.push(h);
        return () => {};
      },
    },
    sessions: { get: () => undefined },
    tools: { register: () => {} },
    connection: { requestRejection: () => undefined },
    // 宿主里没有任何可选服务可用（webRuntime 不存在）
    get: () => undefined,
    effect: (fn: () => () => void) => {
      fn();
      return () => {};
    },
    logger: { info: () => {}, error: () => {} },
  };
}

describe('插件装配（inject / apply）', () => {
  let home = '';
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbtool-apply-'));
    prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('inject 不含宿主未提供的 webRuntime', () => {
    expect(inject).not.toContain('webRuntime');
  });

  it('宿主没有 webRuntime 时仍注册 /dsh-db-tool/api 前缀路由', () => {
    const routes: Route[] = [];
    apply(makeCtx(routes) as never);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.kind).toBe('prefix');
    expect(routes[0]?.path).toBe('/dsh-db-tool/api');
  });

  it('读不到 webRuntime 时 handler 退化为空信任列表，loopback 仍放行', async () => {
    const routes: Route[] = [];
    apply(makeCtx(routes) as never);
    const handler = routes[0]!.handler;

    const res = {
      statusCode: 0,
      ended: false,
      writeHead(code: number) {
        this.statusCode = code;
      },
      setHeader() {},
      end() {
        this.ended = true;
      },
    };
    await handler({ method: 'OPTIONS', url: '/dsh-db-tool/api/connections', headers: { host: '127.0.0.1:55606' } }, res);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });
});
