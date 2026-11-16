'use strict';

const { app, powerMonitor, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

const DAEMON_PLIST = 'com.sifang.screentimeoutscheduler.daemon.plist';

// 原生工具只接受固定子命令；提权服务不会接收任意 shell 命令。
function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mac', 'screen-timeout-helper')
    : path.join(__dirname, '..', 'build', 'mac', 'screen-timeout-helper');
}

function callHelper(args) {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || error.message).trim()));
        try { resolve(JSON.parse(stdout)); }
        catch (_) { reject(new Error('macOS 辅助工具返回了无效数据')); }
      });
  });
}

function daemonStatus() {
  try {
    return app.getLoginItemSettings({ type: 'daemonService', serviceName: DAEMON_PLIST }).status;
  } catch (_) { return 'not-found'; }
}

function ensureDaemon() {
  // 系统只会在首次注册或用户撤销批准后请求授权。
  if (daemonStatus() === 'not-registered') {
    try { app.setLoginItemSettings({ type: 'daemonService', serviceName: DAEMON_PLIST, openAtLogin: true }); }
    catch (_) { return 'not-found'; }
  }
  return daemonStatus();
}

async function applyTimeout(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 999) return false;
  const status = ensureDaemon();
  if (status !== 'enabled') return false;
  try { return (await callHelper(['apply', String(minutes)])).ok === true; }
  catch (_) { return false; }
}

async function refreshOccupants() {
  const result = await callHelper(['assertions']);
  if (!result.ok || !Array.isArray(result.entries)) throw new Error(result.msg || '无法读取电源断言');
  return result.entries;
}

function pollLocked() {
  // Electron 的 locked 状态可补偿少量丢失的锁屏事件。
  const state = powerMonitor.getSystemIdleState(1);
  return state === 'unknown' ? null : state === 'locked';
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  } catch (_) { return false; }
}

function autoStartActive() {
  try { return app.getLoginItemSettings().openAtLogin; }
  catch (_) { return false; }
}

function wasOpenedAtLogin() {
  try { return !!app.getLoginItemSettings().wasOpenedAtLogin; }
  catch (_) { return false; }
}

function openLoginSettings() {
  return shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
}

module.exports = {
  applyTimeout, refreshOccupants, pollLocked, setAutoStart,
  autoStartActive, wasOpenedAtLogin, daemonStatus, ensureDaemon, openLoginSettings
};
