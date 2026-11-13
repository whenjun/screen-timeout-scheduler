'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification,
        powerMonitor, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const APP_TITLE = '熄屏时间调度器';
const AUMID = 'Sifang.ScreenTimeoutScheduler';
const CHECK_MS = 20 * 1000;
const LOCK_POLL_MS = 3 * 1000;
const LOCK_NOTIFY_DELAY_MS = 2000;

const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_PATH = path.join(CONFIG_DIR, 'status.log');
const LEGACY_CONFIG = path.join(process.env.APPDATA || '', 'ScreenTimeoutScheduler', 'config.json');

const DEFAULT_CONFIG = {
  work_start: '09:00', work_end: '18:00',
  work_timeout: 30, off_timeout: 3,
  lunch_enabled: true, lunch_start: '12:00', lunch_end: '13:00', lunch_timeout: 30,
  lock_timeout: 1, notify_on_lock: true, auto_start: false
};

const MODE_LABEL = { work: '上班时段', lunch: '午休时段', off: '下班时段', lock: '锁屏时段' };
const MODE_COLOR = { work: '#16a34a', lunch: '#d97706', off: '#6b7280', lock: '#1d4ed8' };
const SYSTEM_CRITICAL = new Set([
  'system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'ntoskrnl.exe', 'winlogon.exe'
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
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
    // 首次运行：迁移 Python 旧版配置，避免用户重新设置一遍
    if (fs.existsSync(LEGACY_CONFIG)) {
      const old = JSON.parse(fs.readFileSync(LEGACY_CONFIG, 'utf8'));
      const merged = { ...DEFAULT_CONFIG, ...old };
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
  const clean = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    clean[k] = next[k] === undefined ? cfg[k] : next[k];
  }
  clean.work_timeout = clampInt(clean.work_timeout, 0, 999);
  clean.off_timeout = clampInt(clean.off_timeout, 0, 999);
  clean.lunch_timeout = clampInt(clean.lunch_timeout, 0, 999);
  clean.lock_timeout = clampInt(clean.lock_timeout, 0, 999);
  clean.work_start = normalizeTime(clean.work_start, '09:00');
  clean.work_end = normalizeTime(clean.work_end, '18:00');
  clean.lunch_start = normalizeTime(clean.lunch_start, '12:00');
  clean.lunch_end = normalizeTime(clean.lunch_end, '13:00');
  clean.lunch_enabled = !!clean.lunch_enabled;
  clean.notify_on_lock = !!clean.notify_on_lock;
  clean.auto_start = !!clean.auto_start;
  cfg = clean;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  app.setLoginItemSettings({
    openAtLogin: cfg.auto_start,
    path: process.execPath,
    args: ['--hidden']
  });
  logEvent('配置已保存');
}

function clampInt(v, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

function normalizeTime(v, fallback) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, +m[1]));
  const mi = Math.max(0, Math.min(59, +m[2]));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(s || ''));
  if (!m) return 0;
  return (+m[1]) * 60 + (+m[2]);
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function inWindow(now, start, end) {
  const s = parseHHMM(start), e = parseHHMM(end);
  if (s === e) return false;
  return s < e ? (now >= s && now < e) : (now >= s || now < e);
}

function getMode(now, isLocked) {
  if (isLocked) return 'lock';                       // 锁屏优先级最高
  const inWork = inWindow(now, cfg.work_start, cfg.work_end);
  if (cfg.lunch_enabled && inWork && inWindow(now, cfg.lunch_start, cfg.lunch_end)) {
    return 'lunch';
  }
  return inWork ? 'work' : 'off';
}

function minutesFor(mode) {
  return { lock: cfg.lock_timeout, lunch: cfg.lunch_timeout,
           work: cfg.work_timeout, off: cfg.off_timeout }[mode];
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
    cfg: { ...cfg },
    version: app.getVersion()
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', buildState());
}

async function evaluate(force = false) {
  const mode = getMode(nowMinutes(), locked);
  const minutes = minutesFor(mode);
  if (force || lastMode !== mode) {
    const ok = await applyTimeout(minutes);
    const changed = lastMode !== mode;
    lastMode = mode;
    currentMinutes = minutes;
    lastApplyOk = ok;
    logEvent(`应用 ${MODE_LABEL[mode]} 熄屏 ${minutes} 分钟 (powercfg=${ok ? 'OK' : 'FAIL'})`);
    if (changed) updateTrayIcon(mode);
    broadcast();
  }
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
  if (SYSTEM_CRITICAL.has(String(name || '').toLowerCase())) {
    return { ok: false, msg: `"${name}" 是系统关键进程，已禁止结束` };
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
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) showWindow();
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
  app.setAppUserModelId(AUMID);

  app.whenReady().then(async () => {
    cfg = loadConfig();
    app.setLoginItemSettings({
      openAtLogin: cfg.auto_start, path: process.execPath, args: ['--hidden']
    });
    ensureNotificationRegistry();
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

    logEvent(`程序启动 v${app.getVersion()} locked=${locked}`);
    await evaluate(true);

    checkTimer = setInterval(() => evaluate(false), CHECK_MS);
    lockPollTimer = setInterval(pollLockFallback, LOCK_POLL_MS);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', e => { /* 托盘常驻，不退出 */ });
}
