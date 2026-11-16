'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  work_start: '09:00', work_end: '18:00',
  work_timeout: 30, off_timeout: 3,
  lunch_enabled: true, lunch_start: '12:00', lunch_end: '13:00', lunch_timeout: 30,
  lock_timeout: 1, notify_on_lock: true, auto_start: false
};

function clampInt(value, low, high) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : low;
}

function normalizeTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeConfig(next, current = DEFAULT_CONFIG) {
  // 只保存已知字段，避免渲染进程把额外数据带入系统配置。
  const clean = {};
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    clean[key] = next[key] === undefined ? current[key] : next[key];
  }
  for (const key of ['work_timeout', 'off_timeout', 'lunch_timeout', 'lock_timeout']) {
    clean[key] = clampInt(clean[key], 0, 999);
  }
  for (const key of ['work_start', 'work_end', 'lunch_start', 'lunch_end']) {
    clean[key] = normalizeTime(clean[key], DEFAULT_CONFIG[key]);
  }
  for (const key of ['lunch_enabled', 'notify_on_lock', 'auto_start']) clean[key] = !!clean[key];
  return clean;
}

function persistConfig(file, next, current) {
  const clean = normalizeConfig(next, current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, persistConfig };
