/**
 * 满阈值 = 本机崩溃日志里最高的一次致命堆，且必须能跟着日志变。这一段是纯函数：签名文本解析、
 * 取最大、脏数据不吃掉整个读数；动态刷新由 index 的 stat 缓存负责，这里钉住数据来源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { maxCrashHeapMB } from '../core.mjs';

test('取本机最高致命堆，不是最近一次也不是平均', () => {
  const rows = [
    { signature: 'out-of-memory · heap 3529 MB' },
    { signature: 'out-of-memory · heap 4037 MB' },
    { signature: 'out-of-memory · heap 3654 MB' },
  ];
  assert.equal(maxCrashHeapMB(rows), 4037);
});

test('没有崩溃记录就是 0：调用方据此退回「上限 × 85%」', () => {
  assert.equal(maxCrashHeapMB([]), 0);
  assert.equal(maxCrashHeapMB(undefined), 0);
  assert.equal(maxCrashHeapMB([{ signature: 'SyntaxError · Unexpected token' }]), 0);
});

test('脏条目不影响读数', () => {
  const rows = [{ signature: null }, {}, { signature: 'heap abc MB' }, { signature: 'heap 3900 MB' }];
  assert.equal(maxCrashHeapMB(rows), 3900);
});
