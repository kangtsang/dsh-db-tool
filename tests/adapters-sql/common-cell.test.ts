/**
 * normalizeCell 的边界防御（跨 kind 共享单元格规范化）。
 *
 * 背景：normalizeCell 是所有 SQL 系适配器把驱动返回值收敛成 string | number | null 的
 * 唯一出口。Invalid Date 曾直接 `toISOString()` 抛 RangeError —— 单个坏单元格会把整条
 * 查询打成失败（对抗式审查发现，非 sqlserver 特有）。
 */
import { describe, expect, it } from 'vitest';
import { normalizeCell } from '../../lib/adapters/sql-shared/common.js';

describe('normalizeCell 边界', () => {
  it('Invalid Date 不抛错，降级为字符串而非让整查询失败', () => {
    const bad = new Date('not-a-date');
    expect(() => normalizeCell(bad)).not.toThrow();
    expect(normalizeCell(bad)).toBe('Invalid Date');
  });

  it('正常 Date → ISO 字符串', () => {
    expect(normalizeCell(new Date('2020-01-02T03:04:05.000Z'))).toBe('2020-01-02T03:04:05.000Z');
  });

  it('bigint 安全范围内转 number，超范围保持字符串（防精度丢失）', () => {
    expect(normalizeCell(42n)).toBe(42);
    expect(normalizeCell(2n ** 60n)).toBe('1152921504606846976');
  });
});
