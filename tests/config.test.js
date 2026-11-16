'use strict';

// 验证持久化后的配置仍能安全用于两个系统的电源设置调用。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CONFIG, persistConfig } = require('../src/config');

test('保存配置时限制分钟范围、标准化时间并忽略未知字段', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-timeout-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const saved = persistConfig(file, {
    lock_timeout: 0, work_timeout: 1200, off_timeout: -3,
    work_start: '9:5', auto_start: true, unwanted: 'ignore'
  }, DEFAULT_CONFIG);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
  assert.equal(saved.lock_timeout, 0);
  assert.equal(saved.work_timeout, 999);
  assert.equal(saved.off_timeout, 0);
  assert.equal(saved.work_start, '09:05');
  assert.equal(Object.hasOwn(saved, 'unwanted'), false);
});
