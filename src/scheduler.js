'use strict';

// 将时段判定独立出来，便于在两个系统上使用同一套规则。
function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function inWindow(now, start, end) {
  const from = parseHHMM(start);
  const to = parseHHMM(end);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

function getMode(config, now, locked) {
  if (locked) return 'lock';
  const working = inWindow(now, config.work_start, config.work_end);
  if (working && config.lunch_enabled && inWindow(now, config.lunch_start, config.lunch_end)) {
    return 'lunch';
  }
  return working ? 'work' : 'off';
}

async function evaluateMode(previousMode, config, now, locked, force, apply) {
  const mode = getMode(config, now, locked);
  const minutes = config[`${mode}_timeout`];
  if (!force && previousMode === mode) return { applied: false, mode, minutes };
  // 应用失败也保留失败状态，界面不能把配置已保存误报成系统已同步。
  let applyOk = false;
  try { applyOk = await apply(minutes); } catch (_) { applyOk = false; }
  return { applied: true, mode, minutes, applyOk, changed: previousMode !== mode };
}

module.exports = { parseHHMM, inWindow, getMode, evaluateMode };
