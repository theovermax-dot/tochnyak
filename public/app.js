// Точняк: клиент мини-аппа. Без сборки и зависимостей, только Telegram WebApp SDK.

const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';

const LEAGUES = {
  PL: 'АПЛ', PD: 'Ла Лига', SA: 'Серия А', BL1: 'Бундеслига', FL1: 'Лига 1', CL: 'Лига чемпионов', DED: 'Эредивизи'
};
const LEAGUE_ORDER = ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'DED'];

const state = {
  profile: null,
  matches: [],
  league: 'ALL',
  period: 'week',
  sheet: null
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2) || '?').toUpperCase();

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Ошибка сети');
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

function haptic(kind) {
  try {
    if (!tg || !tg.HapticFeedback) return;
    if (kind === 'success' || kind === 'error') tg.HapticFeedback.notificationOccurred(kind);
    else tg.HapticFeedback.impactOccurred(kind || 'light');
  } catch { /* старые клиенты Telegram */ }
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

// ---------- Вход ----------

function showGate(which) {
  for (const id of ['gate-loading', 'gate-outside', 'gate-login', 'gate-error']) $(id).hidden = id !== which;
  $('gate').hidden = false;
  $('app').hidden = true;
}

async function boot() {
  if (tg) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#02060E');
      tg.setBackgroundColor('#02060E');
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch { /* не все клиенты это умеют */ }
  }
  if (!initData) {
    showGate('gate-outside');
    return;
  }
  showGate('gate-loading');
  try {
    const me = await api('/api/me');
    if (!me.registered) {
      $('login-name').textContent = me.firstName || 'Игрок';
      $('login-avatar').textContent = initials(me.firstName);
      showGate('gate-login');
      return;
    }
    await enterApp(me.profile);
  } catch (err) {
    $('gate-error-text').textContent = err.status === 401
      ? 'Telegram не подтвердил вход. Закрой приложение и открой его заново через бота.'
      : 'Не получилось загрузиться. Проверь интернет и попробуй ещё раз.';
    showGate('gate-error');
  }
}

$('login-btn').addEventListener('click', async () => {
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').hidden = true;
  try {
    const res = await api('/api/auth', { method: 'POST', body: { accept: true } });
    haptic('success');
    await enterApp(res.profile);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
    haptic('error');
  } finally {
    btn.disabled = false;
  }
});

$('retry-btn').addEventListener('click', boot);

async function enterApp(profile) {
  state.profile = profile;
  renderTop();
  $('gate').hidden = true;
  $('app').hidden = false;
  const start = location.hash === '#profile' ? 'profile' : 'matches';
  go(start);
}

function renderTop() {
  const p = state.profile;
  $('top-aura').textContent = p.aura.toLocaleString('ru-RU');
  $('top-avatar').textContent = initials(p.firstName);
}

// ---------- Навигация ----------

function go(view) {
  for (const v of ['matches', 'rating', 'profile']) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.go === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (view === 'matches') loadMatches();
  if (view === 'rating') loadRating();
  if (view === 'profile') loadProfile();
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-go]');
  if (target) { haptic('light'); go(target.dataset.go); }
});

// ---------- Матчи ----------

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

function dayLabel(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  const s = dayFmt.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function untilText(ms) {
  if (ms <= 0) return '0:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

async function loadMatches() {
  if (!state.matches.length) $('match-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api('/api/matches');
    state.matches = data.matches;
    renderMatches();
  } catch (err) {
    $('match-list').innerHTML = `<div class="glass empty"><b>Матчи не загрузились</b>${esc(err.message)}</div>`;
  }
}

function renderMatches() {
  const all = state.matches;
  const present = LEAGUE_ORDER.filter((code) => all.some((m) => m.competition === code));
  if (state.league !== 'ALL' && !present.includes(state.league)) state.league = 'ALL';

  const chip = (code, label, count) => `<button type="button" class="chip" role="tab" data-league="${code}" aria-selected="${state.league === code}">${esc(label)} · ${count}</button>`;
  $('league-chips').innerHTML = [chip('ALL', 'Все', all.length)]
    .concat(present.map((code) => chip(code, LEAGUES[code] || code, all.filter((m) => m.competition === code).length)))
    .join('');

  const list = state.league === 'ALL' ? all : all.filter((m) => m.competition === state.league);
  renderHero(list);

  if (!list.length) {
    $('match-list').innerHTML = '<div class="glass empty"><b>Матчей пока нет</b>Расписание обновляется каждые 10 минут. Загляни чуть позже.</div>';
    return;
  }

  const groups = [];
  for (const m of list) {
    const label = dayLabel(m.utcDate);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  $('match-list').innerHTML = groups.map((g) => `
    <p class="day-label">${esc(g.label)}</p>
    <div class="glass list-card">${g.items.map(matchRow).join('')}</div>
  `).join('');
}

function matchTag(m) {
  const p = m.prediction;
  if (m.score && m.status === 'FINISHED') {
    if (!p) return `<span class="tag tag-closed num">${m.score.home}:${m.score.away}</span>`;
    if (p.points == null) return `<span class="tag tag-closed">${m.score.home}:${m.score.away} · считаем</span>`;
    return `<span class="tag ${p.points > 0 ? 'tag-hit' : 'tag-miss'}">${p.home}:${p.away} · +${p.points}</span>`;
  }
  if (m.open) return p ? `<span class="tag tag-pred">${p.home}:${p.away}</span>` : '<span class="tag tag-open">Прогноз</span>';
  if (['IN_PLAY', 'PAUSED'].includes(m.status)) return `<span class="tag tag-closed">Идёт${p ? ` · ${p.home}:${p.away}` : ''}</span>`;
  if (m.status === 'POSTPONED') return '<span class="tag tag-closed">Перенесён</span>';
  return `<span class="tag tag-closed">${p ? `${p.home}:${p.away}` : 'Закрыт'}</span>`;
}

function matchRow(m) {
  const teams = `${esc(m.home.short)} — ${esc(m.away.short)}`;
  const label = `${teams}, ${LEAGUES[m.competition] || m.competitionName}`;
  return `<button type="button" class="match-row" data-match="${m.id}" ${m.open ? '' : 'aria-disabled="true"'} aria-label="${label}">
    <span class="match-time">${timeFmt.format(new Date(m.utcDate))}</span>
    <span class="match-teams"><b>${teams}</b><span>${esc(LEAGUES[m.competition] || m.competitionName)}</span></span>
    ${matchTag(m)}
  </button>`;
}

function renderHero(list) {
  const next = list.find((m) => m.open && !m.prediction) || list.find((m) => m.open);
  if (!next) { $('hero').innerHTML = ''; return; }
  const left = Date.parse(next.lockAt) - Date.now();
  $('hero').innerHTML = `
    <div class="glass hero">
      <div class="hero-meta"><span>${esc(LEAGUES[next.competition] || next.competitionName)} · ${esc(dayLabel(next.utcDate).toLowerCase())} ${timeFmt.format(new Date(next.utcDate))}</span>
        <span class="badge">Приём до ${timeFmt.format(new Date(next.lockAt))}</span></div>
      <div class="versus">
        <span class="team"><span class="crest">${esc(next.home.tla)}</span>${esc(next.home.short)}</span>
        <span class="countdown"><span class="num">${untilText(left)}</span><span class="muted small">до закрытия</span></span>
        <span class="team"><span class="crest crest-away">${esc(next.away.tla)}</span>${esc(next.away.short)}</span>
      </div>
      <button type="button" class="btn btn-primary" data-match="${next.id}">${next.prediction ? `Твой прогноз ${next.prediction.home}:${next.prediction.away} · изменить` : 'Вангануть счёт'}</button>
    </div>`;
}

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-league]');
  if (chip) { state.league = chip.dataset.league; haptic('light'); renderMatches(); return; }
  const row = e.target.closest('[data-match]');
  if (row) {
    const m = state.matches.find((x) => x.id === Number(row.dataset.match));
    if (!m) return;
    if (!m.open) { toast(m.status === 'FINISHED' ? 'Матч уже сыгран' : 'Приём прогнозов закрыт'); return; }
    openSheet(m);
  }
});

// ---------- Окно прогноза ----------

function openSheet(m) {
  state.sheet = { match: m, home: m.prediction ? m.prediction.home : 1, away: m.prediction ? m.prediction.away : 1 };
  $('sheet-meta').textContent = `${LEAGUES[m.competition] || m.competitionName} · ${dayLabel(m.utcDate).toLowerCase()} ${timeFmt.format(new Date(m.utcDate))} · приём до ${timeFmt.format(new Date(m.lockAt))}`;
  $('home-name').textContent = m.home.short;
  $('away-name').textContent = m.away.short;
  $('home-crest').textContent = m.home.tla;
  $('away-crest').textContent = m.away.tla;
  $('sheet-error').hidden = true;
  renderSheet();
  $('sheet').hidden = false;
  haptic('light');
}

function closeSheet() {
  $('sheet').hidden = true;
  state.sheet = null;
}

function renderSheet() {
  const s = state.sheet;
  $('home-score').textContent = s.home;
  $('away-score').textContent = s.away;
  const outcome = s.home > s.away ? `Победа: ${s.match.home.short}` : s.home < s.away ? `Победа: ${s.match.away.short}` : 'Ничья';
  const btts = s.home > 0 && s.away > 0 ? 'Обе забьют' : 'Не обе забьют';
  const total = s.home + s.away > 2 ? 'Больше 2,5' : 'Меньше 2,5';
  $('sheet-pills').innerHTML = [outcome, btts, total].map((t) => `<span class="pill">${esc(t)}</span>`).join('');
  $('save-btn').textContent = `Залочить ${s.home}:${s.away}`;
}

$('sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { closeSheet(); return; }
  const step = e.target.closest('[data-step]');
  if (step && state.sheet) {
    const [side, delta] = step.dataset.step.split(':');
    state.sheet[side] = Math.max(0, Math.min(15, state.sheet[side] + Number(delta)));
    haptic('light');
    renderSheet();
  }
});

$('save-btn').addEventListener('click', async () => {
  const s = state.sheet;
  if (!s) return;
  const btn = $('save-btn');
  btn.disabled = true;
  try {
    await api('/api/predictions', { method: 'POST', body: { matchId: s.match.id, home: s.home, away: s.away } });
    s.match.prediction = { home: s.home, away: s.away, points: null };
    haptic('success');
    closeSheet();
    renderMatches();
    toast(`Залочено: ${s.home}:${s.away}`);
  } catch (err) {
    $('sheet-error').textContent = err.message;
    $('sheet-error').hidden = false;
    haptic('error');
    if (err.code === 'locked') loadMatches();
  } finally {
    btn.disabled = false;
  }
});

// ---------- Рейтинг ----------

document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
  state.period = b.dataset.period;
  document.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  haptic('light');
  loadRating();
}));

async function loadRating() {
  $('rating-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api(`/api/leaderboard?period=${state.period}`);
    const me = data.me;
    const label = state.period === 'week' ? 'Твоя аура за неделю' : 'Твоя аура за всё время';
    $('rating-me').innerHTML = `<div class="glass me-card">
      <span><span class="muted small">${label}</span><br><span class="num big">${me.pts}</span></span>
      <span class="center"><span class="muted small">Место</span><br><span class="num big">${me.rank || '—'}</span></span>
    </div>`;
    if (!data.rows.length) {
      $('rating-list').innerHTML = `<div class="glass empty"><b>Таблица пока пустая</b>${state.period === 'week' ? 'Аура за неделю появится после первых сыгранных матчей.' : 'Сделай прогноз и стань первым в таблице.'}</div>`;
      return;
    }
    $('rating-list').innerHTML = `<div class="glass list-card">${data.rows.map((r) => `
      <div class="lb-row${r.isMe ? ' me' : ''}">
        <span class="lb-rank num">${r.rank}</span>
        <span class="avatar avatar-sm" aria-hidden="true">${esc(initials(r.name))}</span>
        <span class="lb-name">${r.isMe ? 'Ты' : esc(r.name)}</span>
        <span class="lb-pts num">${r.pts}</span>
      </div>`).join('')}</div>`;
  } catch (err) {
    $('rating-list').innerHTML = `<div class="glass empty"><b>Рейтинг не загрузился</b>${esc(err.message)}</div>`;
  }
}

// ---------- Профиль ----------

async function loadProfile() {
  try {
    const me = await api('/api/me');
    if (me.registered) { state.profile = me.profile; renderTop(); }
  } catch { /* покажем то, что уже есть */ }
  const p = state.profile;
  $('profile-card').innerHTML = `<div class="glass profile-card">
    <div class="profile-head"><span class="avatar" aria-hidden="true">${esc(initials(p.firstName))}</span>
      <span><b>${esc(p.firstName || 'Игрок')}</b><br><span class="muted small">Вход через Telegram</span></span></div>
    <div class="stats">
      <div class="stat"><span class="num">${p.aura}</span><span class="muted small">аура всего</span></div>
      <div class="stat"><span class="num">${p.weekAura}</span><span class="muted small">за неделю</span></div>
      <div class="stat"><span class="num">${p.exactHits}</span><span class="muted small">точняков</span></div>
      <div class="stat"><span class="num">${p.settledPredictions}</span><span class="muted small">сыгранных прогнозов</span></div>
    </div>
  </div>`;
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm) {
      try { tg.showConfirm(text, (ok) => resolve(Boolean(ok))); return; } catch { /* ниже запасной вариант */ }
    }
    resolve(window.confirm(text));
  });
}

$('delete-btn').addEventListener('click', async () => {
  const ok = await confirmDialog('Удалить аккаунт? Твоя аура, прогнозы и место в рейтинге будут стёрты без возможности восстановления.');
  if (!ok) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    haptic('success');
    state.profile = null;
    state.matches = [];
    $('login-name').textContent = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.first_name : 'Игрок';
    showGate('gate-login');
    toast('Аккаунт и данные удалены');
  } catch (err) {
    toast(err.message);
  }
});

boot();
