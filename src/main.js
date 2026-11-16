'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification,
        powerMonitor, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const scheduler = require('./scheduler');
const { DEFAULT_CONFIG, normalizeConfig, persistConfig } = require('./config');
// 系统相关操作集中在适配层，避免 Windows 命令进入 macOS 路径。
const mac = process.platform === 'darwin' ? require('./platform-mac') : null;

const APP_TITLE = '熄屏时间调度器';
const AUMID = 'Sifang.ScreenTimeoutScheduler';
const CHECK_MS = 20 * 1000;
const LOCK_POLL_MS = 3 * 1000;
const LOCK_NOTIFY_DELAY_MS = 2000;

const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'status.log');
const LEGACY_CONFIG = mac ? null : path.join(process.env.APPDATA || '', 'ScreenTimeoutScheduler', 'config.json');

const MODE_LABEL = { work: '上班时段', lunch: '午休时段', off: '下班时段', lock: '锁屏时段' };
const MODE_COLOR = { work: '#16a34a', lunch: '#d97706', off: '#6b7280', lock: '#1d4ed8' };
const SYSTEM_CRITICAL = new Set([
  'system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'ntoskrnl.exe', 'winlogon.exe',
  'launchd', 'kernel_task', 'loginwindow', 'windowserver', 'powerd'
]);

let cfg = { ...DEFAULT_CONFIG };
let win = null;
let tray = null;
let quitting = false;
let locked = false;
let lockDetail = '初始化中…';
let lastMode = null;
let currentMinutes = 0;
let lastApplyOk = true;
let lastPowerEventAt = 0;
let notifyTimer = null;
let checkTimer = null;
let lockPollTimer = null;
let evaluationQueue = Promise.resolve();

// ---------------- 基础设施 ----------------

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logEvent(msg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) {
        fs.renameSync(LOG_PATH, LOG_PATH + '.old');
      }
    } catch (_) { /* 轮转失败不影响主流程 */ }
    fs.appendFileSync(LOG_PATH, `${stamp()}  ${msg}\n`, 'utf8');
  } catch (_) { /* 日志失败不影响主流程 */ }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
    // 首次运行：迁移 Python 旧版配置，避免用户重新设置一遍
    if (LEGACY_CONFIG && fs.existsSync(LEGACY_CONFIG)) {
      const old = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      const merged = normalizeConfig(old);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
      logEvent('已从 Python 旧版迁移配置');
      return merged;
    }
  } catch (e) {
    logEvent(`配置读取失败: ${e.message}`);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(next) {
  cfg = persistConfig(CONFIG_PATH, next, cfg);
  setAutoStart(cfg.auto_start);
  logEvent('配置已保存');
}

function setAutoStart(enabled) {
  // macOS 登录项由系统管理，Windows 继续沿用原来的隐藏启动参数。
  if (mac) return mac.setAutoStart(enabled);
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function getMode(now, isLocked) {
  return scheduler.getMode(cfg, now, isLocked);
}

// ---------------- 系统操作 ----------------

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      windowsHide: true, timeout: 15000, encoding: 'buffer',
      maxBuffer: 4 * 1024 * 1024, ...opts
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '')
    }));
  });
}

function decodeCli(buf) {
  for (const enc of ['utf-8', 'gbk', 'cp437']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch (_) { /* 换下一个编码 */ }
  }
  return buf.toString('utf8');
}

async function applyTimeout(minutes) {
  if (mac) return mac.applyTimeout(minutes);
  const results = await Promise.all(
    ['monitor-timeout-ac', 'monitor-timeout-dc'].map(opt =>
      run('powercfg', ['/change', opt, String(minutes)]).then(r => r.ok))
  );
  return results.every(Boolean);
}

function buildState() {
  return {
    mode: lastMode || getMode(nowMinutes(), locked),
    modeLabel: MODE_LABEL[lastMode || getMode(nowMinutes(), locked)],
    minutes: currentMinutes,
    minutesFor: {
      lock: cfg.lock_timeout, lunch: cfg.lunch_timeout,
      work: cfg.work_timeout, off: cfg.off_timeout
    },
    applyOk: lastApplyOk,
    locked,
    lockDetail,
    platform: process.platform,
    daemonStatus: mac ? mac.daemonStatus() : null,
    autoStartActive: mac ? mac.autoStartActive() : null,
    cfg: { ...cfg },
    version: app.getVersion()
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', buildState());
}

function evaluate(force = false) {
  // 顺序执行系统设置写入，避免锁屏事件与定时检查交错后应用旧策略。
  evaluationQueue = evaluationQueue.catch(e => logEvent(`策略队列失败: ${e.message}`)).then(async () => {
    const result = await scheduler.evaluateMode(lastMode, cfg, nowMinutes(), locked, force || !lastApplyOk, applyTimeout);
    if (!result.applied) return;
    lastMode = result.mode;
    currentMinutes = result.minutes;
    lastApplyOk = result.applyOk;
    logEvent(`应用 ${MODE_LABEL[result.mode]} 熄屏 ${result.minutes} 分钟 (${mac ? 'pmset' : 'powercfg'}=${result.applyOk ? 'OK' : 'FAIL'})`);
    if (result.changed) updateTrayIcon(result.mode);
    broadcast();
  });
  return evaluationQueue;
}

// ---------------- 锁屏检测 ----------------

function setLocked(value, source) {
  if (locked === value) return;
  locked = value;
  lockDetail = source;
  logEvent(`锁屏状态变化 -> locked=${value} (${source})`);
  broadcast();
  evaluate(true);
  scheduleLockNotify(value);
}

function scheduleLockNotify(isLocked) {
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  if (!cfg.notify_on_lock) { logEvent('通知已关闭，跳过'); return; }
  // 锁屏后 Win11 需要 1~2 秒完成安全桌面切换，过早提交的 Toast 不会渲染在锁屏上
  const delay = isLocked ? LOCK_NOTIFY_DELAY_MS : 0;
  if (delay) logEvent(`将在 ${delay}ms 后发送锁屏通知（等待锁屏界面就绪）`);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (locked !== isLocked) {
      logEvent(`通知跳过：状态已变为 locked=${locked}`);
      return;
    }
    const label = MODE_LABEL[lastMode] || '';
    const t = currentMinutes === 0 ? '永不熄屏' : `${currentMinutes} 分钟`;
    const state = isLocked ? '已锁屏' : '已解锁';
    const body = `${state} · 当前：${label} · 熄屏超时 ${t}（${stamp().slice(11)}）`;
    const ok = sendToast(APP_TITLE, body);
    logEvent(`通知已发送(Toast=${ok}): ${body}`);
  }, delay);
}

function sendToast(title, body) {
  try {
    if (!Notification.isSupported()) return false;
    const n = new Notification({ title, body, silent: true });
    n.on('click', showWindow);
    n.show();
    return true;
  } catch (e) {
    logEvent(`Toast 失败: ${e.message}`);
    return false;
  }
}

async function pollLockFallback() {
  // powerMonitor 事件刚到时不要抢，避免短暂抖动
  if (Date.now() - lastPowerEventAt < 3000) return;
  if (mac) {
    const present = mac.pollLocked();
    if (present !== null && present !== locked) setLocked(present, '系统空闲状态兜底');
    return;
  }
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH', '/FO', 'CSV']);
  const present = /LogonUI\.exe/i.test(decodeCli(r.stdout));
  if (present !== locked) setLocked(present, 'LogonUI 兜底');
}

function ensureNotificationRegistry() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
  const globals = [
    'NOC_GLOBAL_SETTING_ALLOW_TOASTS',
    'NOC_GLOBAL_SETTING_ALLOW_NOTIFICATION_ON_LOCKSCREEN',
    'NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK'
  ];
  for (const v of globals) {
    run('reg', ['add', base, '/v', v, '/t', 'REG_DWORD', '/d', '1', '/f']);
  }
  run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications',
              '/v', 'ToastEnabled', '/t', 'REG_DWORD', '/d', '1', '/f']);
  // 「在锁屏界面隐藏通知内容」是按应用开关，缺省即隐藏（只显示「私密」）
  for (const v of ['AllowContentAboveLock', 'ShowInActionCenter']) {
    run('reg', ['add', base + '\\' + AUMID, '/v', v, '/t', 'REG_DWORD', '/d', '1', '/f']);
  }
  run('reg', ['add', 'HKCU\\Software\\Classes\\AppUserModelId\\' + AUMID,
              '/v', 'DisplayName', '/t', 'REG_SZ', '/d', APP_TITLE, '/f']);
}

// ---------------- 屏幕占用检测 ----------------

function parseRequests(text) {
  const entries = [];
  let section = null, cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) { cur = null; continue; }
    if (s.endsWith(':') && /^[A-Z]+$/.test(s.slice(0, -1))) {
      section = s.slice(0, -1); cur = null; continue;
    }
    const m = /^\[([A-Za-z]+)\]\s*(.*)$/.exec(s);
    if (m) {
      const type = m[1].toUpperCase();
      const target = m[2].trim();
      const name = target ? target.split('\\').pop() : target;
      cur = { section, type, target, name, reason: '', pids: [] };
      entries.push(cur);
    } else if (cur) {
      cur.reason = (cur.reason + ' ' + s).trim();
    }
  }
  return entries;
}

async function listProcesses() {
  const r = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const list = [];
  for (const line of decodeCli(r.stdout).split(/\r?\n/)) {
    const m = /^"([^"]+)","([^"]+)"/.exec(line.trim());
    if (m) list.push({ name: m[1], pid: parseInt(m[2], 10) });
  }
  return list;
}

async function refreshOccupants() {
  if (mac) return mac.refreshOccupants();
  const r = await run('powercfg', ['/requests']);
  if (!r.ok && !r.stdout.length && !r.stderr.length) {
    throw new Error('无法执行 powercfg /requests');
  }
  const text = decodeCli(Buffer.concat([r.stdout, r.stderr]));
  const entries = parseRequests(text);
  const procs = await listProcesses();
  for (const e of entries) {
    if (e.type === 'PROCESS') {
      e.pids = procs
        .filter(p => p.name.toLowerCase() === e.name.toLowerCase())
        .map(p => p.pid);
    }
  }
  return entries;
}

async function killPid(pid, name) {
  pid = parseInt(pid, 10);
  if (!Number.isFinite(pid)) return { ok: false, msg: '无效的 PID' };
  if (pid === process.pid) return { ok: false, msg: '不能结束本程序自身' };
  if (mac && /^(ScreenTimeout|screen-timeout)/i.test(String(name || ''))) {
    return { ok: false, msg: '不能结束本程序自身' };
  }
  if (SYSTEM_CRITICAL.has(String(name || '').toLowerCase())) {
    return { ok: false, msg: `"${name}" 是系统关键进程，已禁止结束` };
  }
  if (mac) {
    // 再次核对断言及进程名称，防止列表刷新后 PID 被其他进程复用。
    try {
      const current = await refreshOccupants();
      const matching = current.some(e => e.name === name && e.pids.includes(pid));
      if (!matching) return { ok: false, msg: '该进程已不再占用屏幕，请刷新列表' };
      process.kill(pid, 'SIGKILL');
      logEvent(`结束进程 ${name} (PID ${pid}) -> 成功`);
      return { ok: true, msg: `已结束 ${name}（PID ${pid}）` };
    } catch (e) {
      return { ok: false, msg: `结束失败：${e.message}` };
    }
  }
  const r = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
  const detail = decodeCli(Buffer.concat([r.stdout, r.stderr])).trim();
  logEvent(`结束进程 ${name} (PID ${pid}) -> ${r.ok ? '成功' : detail}`);
  return { ok: r.ok, msg: r.ok ? `已结束 ${name}（PID ${pid}）` : (detail || '结束失败') };
}

// ---------------- 窗口与托盘 ----------------

function iconPath(mode) {
  return path.join(__dirname, 'icons', `${mode}.png`);
}

function updateTrayIcon(mode) {
  if (!tray) return;
  try { tray.setImage(nativeImage.createFromPath(iconPath(mode))); } catch (_) { /* 图标缺失忽略 */ }
  const t = currentMinutes === 0 ? '永不熄屏' : `${currentMinutes} 分钟`;
  tray.setToolTip(`${APP_TITLE} — ${MODE_LABEL[mode]} / ${t}`);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath('work')));
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开设置', click: showWindow },
    { label: '立即重新应用', click: () => evaluate(true) },
    { label: '发送测试通知', click: () => {
        const ok = sendToast(APP_TITLE, '测试通知：能看到这条说明通知功能正常。');
        logEvent(`测试通知 Toast=${ok}`);
      } },
    { label: '通知诊断', click: async () => {
        const ok = sendToast(APP_TITLE, '通知诊断：若锁屏显示「私密」，请检查系统通知设置。');
        logEvent(`通知诊断 Toast=${ok} AUMID=${AUMID}`);
      } },
    { label: '查看状态日志', click: () => shell.openPath(LOG_PATH) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', showWindow);
  if (mac) tray.on('click', showWindow);
  updateTrayIcon(lastMode || 'work');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 720,
    minWidth: 940, minHeight: 600,
    frame: false,
    backgroundColor: '#F6F7F9',
    show: false,
    title: APP_TITLE,
    icon: mac ? iconPath('work') : path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !(mac && mac.wasOpenedAtLogin())) showWindow();
  });
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); hideWindow(); }
  });
  win.on('closed', () => { win = null; });
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('state:get', () => buildState());
  ipcMain.handle('config:save', async (_e, next) => {
    saveConfig(next);
    await evaluate(true);
    return buildState();
  });
  ipcMain.handle('app:reapply', async () => { await evaluate(true); return buildState(); });
  ipcMain.handle('app:test-notify', () => {
    const ok = sendToast(APP_TITLE, '测试通知：能看到这条说明通知功能正常。');
    logEvent(`测试通知 Toast=${ok}`);
    return ok;
  });
  ipcMain.handle('app:open-log', () => shell.openPath(LOG_PATH));
  ipcMain.handle('app:open-login-settings', () => mac ? mac.openLoginSettings() : null);
  ipcMain.handle('occupants:refresh', async () => {
    try { return { ok: true, entries: await refreshOccupants() }; }
    catch (e) { return { ok: false, msg: e.message, entries: [] }; }
  });
  ipcMain.handle('occupants:kill', async (_e, pid, name) => killPid(pid, name));

  ipcMain.on('window:minimize', () => win && win.minimize());
  ipcMain.on('window:maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window:close', hideWindow);
  ipcMain.on('window:hide', hideWindow);
}

// ---------------- 启动 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  if (!mac) app.setAppUserModelId(AUMID);

  app.whenReady().then(async () => {
    cfg = loadConfig();
    try { setAutoStart(cfg.auto_start); }
    catch (e) { logEvent(`开机自启设置失败: ${e.message}`); }
    if (mac) {
      try { mac.ensureDaemon(); } catch (e) { logEvent(`后台服务注册失败: ${e.message}`); }
    } else {
      ensureNotificationRegistry();
    }
    registerIpc();
    createWindow();
    createTray();

    powerMonitor.on('lock-screen', () => {
      lastPowerEventAt = Date.now();
      setLocked(true, 'powerMonitor');
    });
    powerMonitor.on('unlock-screen', () => {
      lastPowerEventAt = Date.now();
      setLocked(false, 'powerMonitor');
    });
    powerMonitor.on('resume', () => evaluate(true));

    logEvent(`程序启动 v${app.getVersion()} locked=${locked}`);
    await evaluate(true);

    checkTimer = setInterval(() => evaluate(false), CHECK_MS);
    lockPollTimer = setInterval(pollLockFallback, LOCK_POLL_MS);
  });

  if (mac) app.on('activate', showWindow);

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', e => { /* 托盘常驻，不退出 */ });
}
