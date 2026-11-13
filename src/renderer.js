'use strict';

const $ = id => document.getElementById(id);
const api = window.appApi;

const PAGE_META = {
  overview: ['状态总览', '查看当前生效的策略与运行状态'],
  lock: ['锁屏', '最高优先级策略，锁定后立即生效'],
  lunch: ['午休', '仅在上班时段内生效的休息窗口'],
  work: ['工作时段', '上班与下班两个时段的熄屏策略'],
  occupy: ['屏幕占用', '找出正在阻止显示器熄屏的程序']
};

const MODE_TEXT = {
  lock: ['锁屏时段', '锁屏状态覆盖所有时段规则'],
  lunch: ['午休时段', '处于午休窗口内'],
  work: ['上班时段', '按工作时间段配置运行'],
  off: ['下班时段', '按非工作时间段配置运行']
};

let state = null;
let draft = {};
let dirty = false;
let autoRefreshTimer = null;
let toastTimer = null;
let modalResolve = null;

// ---------------- 提示与确认 ----------------

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function confirmDialog(title, body) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal').classList.add('show');
  $('modal').setAttribute('aria-hidden', 'false');
  return new Promise(resolve => { modalResolve = resolve; });
}

function closeDialog(result) {
  $('modal').classList.remove('show');
  $('modal').setAttribute('aria-hidden', 'true');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}

// ---------------- 页面切换 ----------------

function goto(page) {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.dataset.page === page));
  $('page-title').textContent = PAGE_META[page][0];
  $('page-subtitle').textContent = PAGE_META[page][1];
  document.querySelector('.pages').scrollTop = 0;
  if (page === 'occupy' && !$('occ-auto').checked) refreshOccupants();
}

// ---------------- 表单绑定 ----------------

const NUMBER_FIELDS = [
  ['lock-timeout', 'lock-range', 'lock_timeout'],
  ['lunch-timeout', 'lunch-range', 'lunch_timeout'],
  ['work-timeout', 'work-range', 'work_timeout'],
  ['off-timeout', 'off-range', 'off_timeout']
];

const TIME_FIELDS = [
  ['lunch-start', 'lunch_start'], ['lunch-end', 'lunch_end'],
  ['work-start', 'work_start'], ['work-end', 'work_end']
];

const CHECK_FIELDS = [
  ['notify-lock', 'notify_on_lock'],
  ['lunch-enabled', 'lunch_enabled'],
  ['auto-start', 'auto_start']
];

function markDirty() {
  dirty = true;
  const h = $('save-hint');
  h.classList.add('dirty');
  h.innerHTML = '<span class="dot"></span>有未保存的更改';
}

function markClean() {
  dirty = false;
  const h = $('save-hint');
  h.classList.remove('dirty');
  h.innerHTML = '<span class="dot"></span>所有更改已同步';
}

function bindForms() {
  for (const [numId, rangeId, key] of NUMBER_FIELDS) {
    const num = $(numId), range = $(rangeId);
    num.addEventListener('input', () => {
      const v = Math.max(0, Math.min(999, parseInt(num.value, 10) || 0));
      draft[key] = v;
      range.value = Math.min(v, parseInt(range.max, 10));
      markDirty();
    });
    range.addEventListener('input', () => {
      const v = parseInt(range.value, 10);
      draft[key] = v;
      num.value = v;
      markDirty();
    });
  }
  for (const [id, key] of TIME_FIELDS) {
    $(id).addEventListener('input', () => { draft[key] = $(id).value; markDirty(); });
  }
  for (const [id, key] of CHECK_FIELDS) {
    $(id).addEventListener('change', () => {
      draft[key] = $(id).checked;
      if (id === 'lunch-enabled') syncLunchControls();
      markDirty();
    });
  }
}

function syncLunchControls() {
  const on = $('lunch-enabled').checked;
  $('lunch-switch-label').textContent = on ? '已启用' : '已停用';
  for (const id of ['lunch-start', 'lunch-end', 'lunch-timeout', 'lunch-range']) {
    $(id).disabled = !on;
  }
}

function fillForms(cfg) {
  for (const [numId, rangeId, key] of NUMBER_FIELDS) {
    const v = cfg[key] ?? 0;
    $(numId).value = v;
    $(rangeId).value = Math.min(v, parseInt($(rangeId).max, 10));
  }
  for (const [id, key] of TIME_FIELDS) $(id).value = cfg[key] || '00:00';
  for (const [id, key] of CHECK_FIELDS) $(id).checked = !!cfg[key];
  syncLunchControls();
}

// ---------------- 状态渲染 ----------------

function render(s) {
  state = s;
  const mode = s.mode || 'work';

  $('hero-mode').textContent = MODE_TEXT[mode][0];
  $('hero-note').textContent = MODE_TEXT[mode][1];
  $('hero-number').textContent = s.minutes === 0 ? '∞' : s.minutes;
  $('hero-unit').textContent = s.minutes === 0 ? '永不熄屏' : '分钟后熄屏';

  document.querySelectorAll('.step').forEach(el =>
    el.classList.toggle('active', el.dataset.mode === mode));

  $('stat-lock').textContent = s.locked ? '已锁屏' : '未锁屏';
  $('stat-lock-detail').textContent = s.locked ? '正在使用锁屏超时' : '桌面会话正常';
  $('stat-mode').textContent = MODE_TEXT[mode][0].replace('时段', '');
  $('stat-range').textContent = `${s.cfg.work_start} – ${s.cfg.work_end}`;
  $('stat-apply').textContent = s.applyOk ? '正常' : '失败';
  $('stat-apply').style.color = s.applyOk ? '' : 'var(--red)';
  $('side-version').textContent = `v${s.version}`;

  $('tl-lock').textContent = fmtMinutes(s.cfg.lock_timeout) + '后熄屏';
  $('tl-lunch-tag').textContent = s.cfg.lunch_enabled ? '已启用' : '已停用';
  $('tl-lunch').textContent = `${s.cfg.lunch_start} – ${s.cfg.lunch_end}`;
  $('tl-work-tag').textContent = fmtMinutes(s.cfg.work_timeout);
  $('tl-work').textContent = `${s.cfg.work_start} – ${s.cfg.work_end}`;
  $('tl-off-tag').textContent = fmtMinutes(s.cfg.off_timeout);
  document.querySelectorAll('.tl-row').forEach(r =>
    r.classList.toggle('current', r.dataset.mode === mode));

  const banner = $('lock-banner');
  banner.classList.toggle('locked', !!s.locked);
  $('lock-banner-text').textContent = s.locked
    ? '已锁屏 · 正在使用锁屏超时（优先于下方所有时段）'
    : '未锁屏 · 按下方时段配置生效';

  // 有未保存改动时不覆盖用户正在编辑的表单
  if (!dirty) {
    draft = { ...s.cfg };
    fillForms(s.cfg);
    markClean();
  }
}

function fmtMinutes(v) {
  return v === 0 ? '永不熄屏' : `${v} 分钟`;
}

// ---------------- 操作 ----------------

async function save() {
  try {
    const s = await api.saveConfig(draft);
    dirty = false;
    render(s);
    toast('配置已保存并应用');
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

async function refreshOccupants() {
  const list = $('occupy-list');
  const res = await api.refreshOccupants();
  if (!res.ok) {
    list.innerHTML = `<div class="empty-state"><span>${escapeHtml(res.msg || '检测失败')}</span></div>`;
    return;
  }
  if (!res.entries.length) {
    list.innerHTML = '<div class="empty-state"><svg class="ico"><use href="#i-check"/></svg>' +
      '<span>未检测到程序主动请求保持屏幕常亮</span>' +
      '<span style="font-size:11px">可能由鼠标 / 键盘活动保持，或显示本就正常熄屏</span></div>';
    return;
  }
  list.innerHTML = '';
  for (const e of res.entries) {
    const row = document.createElement('div');
    row.className = 'occ-row';
    const typeCls = e.type === 'PROCESS' ? '' : 'driver';
    const info = document.createElement('div');
    info.className = 'occ-info';
    const name = document.createElement('div');
    name.className = 'occ-name';
    name.textContent = e.name || e.target || '未知';
    const reason = document.createElement('div');
    reason.className = 'occ-reason';
    reason.textContent = [e.section, e.reason].filter(Boolean).join(' · ') || e.target || '';
    info.append(name, reason);

    const actions = document.createElement('div');
    actions.className = 'occ-actions';
    if (e.type === 'PROCESS' && e.pids && e.pids.length) {
      const shown = e.pids.slice(0, 3);
      for (const pid of shown) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-kill';
        btn.textContent = `结束 PID ${pid}`;
        btn.addEventListener('click', () => askKill(pid, e.name));
        actions.appendChild(btn);
      }
      if (e.pids.length > shown.length) {
        const more = document.createElement('span');
        more.style.cssText = 'font-size:11px;color:var(--text-3);align-self:center';
        more.textContent = `另有 ${e.pids.length - shown.length} 个同名进程`;
        actions.appendChild(more);
      }
    } else {
      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:11px;color:var(--text-3)';
      hint.textContent = e.type === 'PROCESS' ? '未找到对应进程' : '驱动 / 服务，无法结束';
      actions.appendChild(hint);
    }
    const tag = document.createElement('span');
    tag.className = 'occ-type ' + typeCls;
    tag.textContent = e.type;
    row.append(tag, info, actions);
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function askKill(pid, name) {
  const ok = await confirmDialog(
    '结束进程',
    `确定要结束 ${name}（PID ${pid}）吗？该操作可能导致关联程序异常退出。`
  );
  if (!ok) return;
  const r = await api.killPid(pid, name);
  toast(r.msg);
  refreshOccupants();
}

// ---------------- 初始化 ----------------

function init() {
  document.querySelectorAll('.nav-item').forEach(b =>
    b.addEventListener('click', () => goto(b.dataset.page)));

  $('btn-min').addEventListener('click', () => api.minimize());
  $('btn-max').addEventListener('click', () => api.maximize());
  $('btn-close').addEventListener('click', () => api.close());
  $('btn-hide').addEventListener('click', () => api.hide());
  $('btn-save').addEventListener('click', save);

  $('quick-reapply').addEventListener('click', async () => {
    const s = await api.reapply();
    render(s);
    toast('已重新应用当前策略');
  });
  $('quick-notify').addEventListener('click', async () => {
    const ok = await api.testNotify();
    toast(ok ? '测试通知已发送' : '通知发送失败');
  });
  $('quick-log').addEventListener('click', () => api.openLog());
  $('lock-test').addEventListener('click', async () => {
    const ok = await api.testNotify();
    toast(ok ? '测试通知已发送' : '通知发送失败');
  });
  $('occ-refresh').addEventListener('click', refreshOccupants);
  $('occ-auto').addEventListener('change', () => {
    if ($('occ-auto').checked) {
      refreshOccupants();
      autoRefreshTimer = setInterval(refreshOccupants, 15000);
    } else {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  });

  $('modal-cancel').addEventListener('click', () => closeDialog(false));
  $('modal-confirm').addEventListener('click', () => closeDialog(true));
  $('modal').addEventListener('click', e => {
    if (e.target === $('modal')) closeDialog(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('modal').classList.contains('show')) closeDialog(false);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });

  bindForms();
  api.onStateChanged(render);
  api.getState().then(render).catch(e => toast('状态读取失败：' + e.message));
}

init();
