'use strict';

// 两个平台共用的策略优先级与失败状态由这些用例约束。

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../src/config');
const { inWindow, getMode, evaluateMode } = require('../src/scheduler');

test('跨午夜时段按起点包含、终点排除判定', () => {
  assert.equal(inWindow(23 * 60, '22:00', '06:00'), true);
  assert.equal(inWindow(5 * 60 + 59, '22:00', '06:00'), true);
  assert.equal(inWindow(6 * 60, '22:00', '06:00'), false);
  assert.equal(inWindow(12 * 60, '22:00', '06:00'), false);
});

test('午休只在工作与午休窗口交集生效，锁屏始终优先', () => {
  const config = { ...DEFAULT_CONFIG, work_start: '09:00', work_end: '12:30', lunch_start: '12:00', lunch_end: '13:00' };
  assert.equal(getMode(config, 12 * 60 + 15, false), 'lunch');
  assert.equal(getMode(config, 12 * 60 + 45, false), 'off');
  assert.equal(getMode(config, 12 * 60 + 15, true), 'lock');
  assert.equal(getMode({ ...config, lunch_enabled: false }, 12 * 60 + 15, false), 'work');
});

test('系统调用失败会返回失败状态，强制应用仍会重试', async () => {
  let calls = 0;
  const apply = async minutes => { calls++; assert.equal(minutes, 30); return false; };
  const first = await evaluateMode(null, DEFAULT_CONFIG, 10 * 60, false, false, apply);
  assert.equal(first.applyOk, false);
  assert.equal(first.mode, 'work');
  assert.equal(first.applied, true);
  assert.equal((await evaluateMode('work', DEFAULT_CONFIG, 10 * 60, false, false, apply)).applied, false);
  assert.equal((await evaluateMode('work', DEFAULT_CONFIG, 10 * 60, false, true, apply)).applyOk, false);
  assert.equal(calls, 2);
});
