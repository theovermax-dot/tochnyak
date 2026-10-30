// Точняк: клиент мини-аппа. Без сборки и зависимостей, только Telegram WebApp SDK.

const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';

const LEAGUES = {
  PL: 'АПЛ', PD: 'Ла Лига', SA: 'Серия А', BL1: 'Бундеслига', FL1: 'Лига 1', CL: 'Лига чемпионов', DED: 'Эредивизи'
};
const LEAGUE_ORDER = ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'DED'];
const QUICK_SCORES = [[1, 0], [2, 0], [2, 1], [1, 1], [0, 0], [0, 1], [1, 2], [3, 1], [2, 2], [0, 2]];
const LIVE = ['IN_PLAY', 'PAUSED'];

const WARDROBE = [
  { id: 'cap', label: 'Кепки', icon: 'i-cap' },
  { id: 'acc', label: 'Аксессуары', icon: 'i-glasses' },
  { id: 'shirt', label: 'Футболки и кофты', icon: 'i-shirt' },
  { id: 'pants', label: 'Штаны и шорты', icon: 'i-pants' },
  { id: 'shoes', label: 'Кроссовки', icon: 'i-shoe' }
];

const state = {
  profile: null,
  matches: [],
  my: [],
  league: 'ALL',
  period: 'week',
  fperiod: 'week',
  mytab: 'wait',
  wardrobe: 'cap',
  view: 'matches',
  sheet: null,
  friendLink: null,
  pendingRef: null
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2) || '?').toUpperCase();
const league = (m) => LEAGUES[m.competition] || m.competitionName;
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;

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
    else if (kind === 'select') tg.HapticFeedback.selectionChanged();
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

// Эмблема клуба. Если картинка не загрузилась, остаётся код команды.
function crest(team, size = '') {
  const img = team.crest ? `<img src="${esc(team.crest)}" alt="" loading="lazy" decoding="async">` : '';
  return `<span class="crest ${size}" title="${esc(team.short)}"><span class="crest-tla">${esc(team.tla)}</span>${img}</span>`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.parentElement && img.parentElement.classList.contains('crest')) img.remove();
}, true);

// ---------- Telegram: полный экран и кнопка «назад» ----------

function setupTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor('#02060E');
    tg.setBackgroundColor('#02060E');
    if (tg.setBottomBarColor) tg.setBottomBarColor('#02060E');
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    const mobile = ['ios', 'android'].includes(tg.platform);
    if (mobile && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen && !tg.isFullscreen) tg.requestFullscreen();
  } catch { /* не все клиенты это умеют */ }
  syncSafeArea();
  try {
    tg.onEvent('safeAreaChanged', syncSafeArea);
    tg.onEvent('contentSafeAreaChanged', syncSafeArea);
    tg.onEvent('fullscreenChanged', syncSafeArea);
    tg.BackButton.onClick(onBack);
  } catch { /* старые клиенты */ }
}

// Отступы сверху и снизу, чтобы кнопки Telegram не перекрывали шапку в полноэкранном режиме.
function syncSafeArea() {
  if (!tg) return;
  const root = document.documentElement.style;
  const sa = tg.safeAreaInset || {};
  const ca = tg.contentSafeAreaInset || {};
  root.setProperty('--app-top', `${(sa.top || 0) + (ca.top || 0)}px`);
  root.setProperty('--app-bottom', `${(sa.bottom || 0) + (ca.bottom || 0)}px`);
}

function syncBackButton() {
  if (!tg || !tg.BackButton) return;
  const show = !$('sheet').hidden || state.view === 'wardrobe';
  try { show ? tg.BackButton.show() : tg.BackButton.hide(); } catch { /* старые клиенты */ }
}

function onBack() {
  if (!$('sheet').hidden) closeSheet();
  else if (state.view === 'wardrobe') go('profile');
}

// ---------- Вход ----------

function showGate(which) {
  for (const id of ['gate-loading', 'gate-outside', 'gate-login', 'gate-error']) $(id).hidden = id !== which;
  $('gate').hidden = false;
  $('app').hidden = true;
}

function readRef() {
  const fromUrl = new URLSearchParams(location.search).get('f');
  const start = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : '';
  const fromStart = /^f_([a-z0-9]{8})$/.exec(start || '');
  const code = fromUrl || (fromStart && fromStart[1]);
  return /^[a-z0-9]{8}$/.test(code || '') ? code : null;
}

async function boot() {
  setupTelegram();
  state.pendingRef = readRef();
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
      ? 'Telegram не подтвердил вход. Открой приложение заново через бота.'
      : 'Не получилось загрузиться. Проверь интернет.';
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
  go(location.hash === '#profile' ? 'profile' : 'matches');
  if (state.pendingRef) acceptInvite(state.pendingRef);
}

async function acceptInvite(code) {
  state.pendingRef = null;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* не страшно */ }
  try {
    const res = await api('/api/friends', { method: 'POST', body: { code } });
    if (res.added) { haptic('success'); toast(`${res.name} теперь в друзьях`); }
  } catch { /* битая ссылка: просто играем дальше */ }
}

function renderTop() {
  const p = state.profile;
  $('top-aura').textContent = p.aura.toLocaleString('ru-RU');
  $('top-coins').textContent = (p.coins || 0).toLocaleString('ru-RU');
  $('wardrobe-coins').textContent = (p.coins || 0).toLocaleString('ru-RU');
  $('top-avatar').textContent = initials(p.firstName);
}

// ---------- Навигация ----------

const VIEWS = ['matches', 'my', 'friends', 'rating', 'profile', 'wardrobe'];

function go(view) {
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  const tab = view === 'wardrobe' ? 'profile' : view;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.go === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  syncBackButton();
  if (view === 'matches') loadMatches();
  if (view === 'my') loadMy();
  if (view === 'friends') loadFriends();
  if (view === 'rating') loadRating();
  if (view === 'profile') loadProfile();
  if (view === 'wardrobe') renderWardrobe();
}

function setSelected(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.setAttribute('aria-selected', String(x.dataset[attr] === value)));
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const goEl = t.closest('[data-go]');
  if (goEl) { haptic('light'); go(goEl.dataset.go); return; }
  const chip = t.closest('[data-league]');
  if (chip) { state.league = chip.dataset.league; haptic('select'); renderMatches(); return; }
  const period = t.closest('[data-period]');
  if (period) { state.period = period.dataset.period; setSelected('period', state.period); haptic('select'); loadRating(); return; }
  const fperiod = t.closest('[data-fperiod]');
  if (fperiod) { state.fperiod = fperiod.dataset.fperiod; setSelected('fperiod', state.fperiod); haptic('select'); loadFriends(); return; }
  const mytab = t.closest('[data-mytab]');
  if (mytab) { state.mytab = mytab.dataset.mytab; setSelected('mytab', state.mytab); haptic('select'); renderMy(); return; }
  const wtab = t.closest('[data-wtab]');
  if (wtab) { state.wardrobe = wtab.dataset.wtab; haptic('select'); renderWardrobe(); return; }
  const friend = t.closest('[data-friend]');
  if (friend) { removeFriend(friend.dataset.friend, friend.dataset.name); return; }
  const row = t.closest('[data-match]');
  if (row) {
    const id = Number(row.dataset.match);
    const m = state.matches.find((x) => x.id === id) || state.my.find((x) => x.id === id);
    if (m) openSheet(m);
  }
});

// ---------- Время ----------

// Всё время в приложении московское, независимо от часового пояса телефона.
const TZ = 'Europe/Moscow';
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: TZ });
const shortDayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: TZ });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });

function dayDiff(date) {
  const d = Date.parse(ymdFmt.format(new Date(date)));
  const today = Date.parse(ymdFmt.format(new Date()));
  return Math.round((d - today) / 86400000);
}

function dayLabel(date) {
  const diff = dayDiff(date);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  const s = dayFmt.format(new Date(date));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function whenShort(date) {
  const diff = dayDiff(date);
  const t = timeFmt.format(new Date(date));
  if (diff === 0) return `сегодня ${t} МСК`;
  if (diff === 1) return `завтра ${t} МСК`;
  if (diff === -1) return `вчера ${t} МСК`;
  return `${shortDayFmt.format(new Date(date))} ${t} МСК`;
}

function untilText(ms) {
  if (ms <= 0) return '0:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// ---------- Матчи ----------

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

  const chip = (code, label) => `<button type="button" class="chip" role="tab" data-league="${code}" aria-selected="${state.league === code}">${esc(label)}</button>`;
  $('league-chips').innerHTML = [chip('ALL', 'Все')].concat(present.map((code) => chip(code, LEAGUES[code] || code))).join('');

  const list = state.league === 'ALL' ? all : all.filter((m) => m.competition === state.league);
  renderHero(list);

  if (!list.length) {
    $('match-list').innerHTML = '<div class="glass empty"><b>Матчей пока нет</b>Загляни чуть позже</div>';
    return;
  }
  const groups = [];
  for (const m of list) {
    const label = dayLabel(m.utcDate);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  $('match-list').innerHTML = `<p class="tz-note">${icon('i-clock')}Время матчей московское (МСК)</p>` + groups.map((g) => `
    <section class="day">
      <h3 class="day-head"><span>${esc(g.label)}</span><span class="day-count num">${g.items.length}</span></h3>
      <div class="glass list-card">${g.items.map(matchRow).join('')}</div>
    </section>`).join('');
}

function centerCell(m) {
  if (LIVE.includes(m.status)) {
    const sc = m.score ? `${m.score.home}:${m.score.away}` : 'LIVE';
    return `<span class="mid"><span class="mid-main num live">${sc}</span><span class="mid-sub live-sub"><i class="dot"></i>идёт</span></span>`;
  }
  if (m.status === 'FINISHED' && m.score) {
    return `<span class="mid"><span class="mid-main num">${m.score.home}:${m.score.away}</span><span class="mid-sub">матч окончен</span></span>`;
  }
  return `<span class="mid"><span class="mid-main num time">${timeFmt.format(new Date(m.utcDate))}</span><span class="mid-sub">${esc(league(m))}</span></span>`;
}

function matchTag(m) {
  const p = m.prediction;
  if (m.status === 'FINISHED' && m.score) {
    if (!p) return '<span class="tag tag-none">—</span>';
    if (p.points == null) return `<span class="tag tag-wait num">${p.home}:${p.away}</span>`;
    return `<span class="tag ${p.points > 0 ? 'tag-hit' : 'tag-miss'}"><span class="num">${p.home}:${p.away}</span><b>+${p.points}</b></span>`;
  }
  if (m.open) return p ? `<span class="tag tag-pred num">${p.home}:${p.away}</span>` : '<span class="tag tag-open">Прогноз</span>';
  if (m.status === 'POSTPONED') return '<span class="tag tag-none">перенос</span>';
  return p ? `<span class="tag tag-wait num">${p.home}:${p.away}</span>` : `<span class="tag tag-none">${icon('i-lock')}</span>`;
}

function matchRow(m) {
  const label = `${m.home.short} — ${m.away.short}, ${league(m)}`;
  return `<button type="button" class="match-row" data-match="${m.id}" aria-label="${esc(label)}">
    <span class="pair">${crest(m.home)}${centerCell(m)}${crest(m.away)}</span>
    ${matchTag(m)}
  </button>`;
}

function renderHero(list) {
  const next = list.find((m) => m.open && !m.prediction) || list.find((m) => m.open);
  if (!next) { $('hero').innerHTML = ''; return; }
  const left = Date.parse(next.lockAt) - Date.now();
  const p = next.prediction;
  $('hero').innerHTML = `
    <div class="glass hero">
      <div class="hero-meta"><span class="league-tag">${esc(league(next))}</span><span class="badge">${icon('i-lock')}<span class="num">${untilText(left)}</span></span></div>
      <div class="versus">
        <span class="team">${crest(next.home, 'crest-lg')}<span>${esc(next.home.short)}</span></span>
        <span class="hero-time"><span class="num">${timeFmt.format(new Date(next.utcDate))}</span><span class="muted small">${esc(dayLabel(next.utcDate).toLowerCase())} · МСК</span></span>
        <span class="team">${crest(next.away, 'crest-lg')}<span>${esc(next.away.short)}</span></span>
      </div>
      <button type="button" class="btn btn-primary" data-match="${next.id}">${p ? `Мой прогноз <span class="num">${p.home}:${p.away}</span>` : 'Вангануть счёт'}</button>
    </div>`;
}

// ---------- Окно матча: прогноз или итог ----------

function openSheet(m) {
  const p = m.prediction;
  state.sheet = { match: m, home: p ? p.home : 1, away: p ? p.away : 0 };
  $('sheet-meta').innerHTML = `<span class="league-tag">${esc(league(m))}</span><span>${esc(whenShort(m.utcDate))}</span>`;
  renderSheet();
  $('sheet').hidden = false;
  syncBackButton();
  haptic('light');
}

function closeSheet() {
  $('sheet').hidden = true;
  state.sheet = null;
  syncBackButton();
}

function teamsHead(m, scoreHtml) {
  return `<div class="sheet-teams">
    <span class="team">${crest(m.home, 'crest-lg')}<b>${esc(m.home.short)}</b></span>
    ${scoreHtml}
    <span class="team">${crest(m.away, 'crest-lg')}<b>${esc(m.away.short)}</b></span>
  </div>`;
}

function renderSheet() {
  const s = state.sheet;
  const m = s.match;
  if (!m.open) { renderResultSheet(m); return; }

  const left = Date.parse(m.lockAt) - Date.now();
  const outcome = s.home > s.away ? `П1 · ${m.home.short}` : s.home < s.away ? `П2 · ${m.away.short}` : 'Ничья';
  const btts = s.home > 0 && s.away > 0 ? 'Обе забьют' : 'Не обе';
  const total = s.home + s.away > 2 ? 'ТБ 2,5' : 'ТМ 2,5';
  $('sheet-body').innerHTML = `
    ${teamsHead(m, '<span class="vs-dash" aria-hidden="true">vs</span>')}
    <div class="score-grid">
      ${stepper('home', s.home, m.home.short)}
      ${stepper('away', s.away, m.away.short)}
    </div>
    <div class="quick" role="group" aria-label="Быстрый выбор счёта">
      ${QUICK_SCORES.map(([h, a]) => `<button type="button" class="chip chip-num num" data-quick="${h}:${a}" aria-pressed="${s.home === h && s.away === a}">${h}:${a}</button>`).join('')}
    </div>
    <div class="pills">${[outcome, btts, total].map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>
    <button type="button" id="save-btn" class="btn btn-primary">${icon('i-lock')}Залочить <span class="num">${s.home}:${s.away}</span></button>
    <p class="sheet-foot">Приём закроется через <span class="num">${untilText(left)}</span></p>
    <p id="sheet-error" class="error center" role="alert" hidden></p>`;
}

function stepper(side, value, name) {
  return `<div class="team-col">
    <button type="button" class="glass step" data-step="${side}:-1" aria-label="${esc(name)}: на гол меньше">−</button>
    <span class="big-score num" aria-live="polite">${value}</span>
    <button type="button" class="glass step" data-step="${side}:1" aria-label="${esc(name)}: на гол больше">+</button>
  </div>`;
}

function renderResultSheet(m) {
  const p = m.prediction;
  let center;
  if (m.score) center = `<span class="final num">${m.score.home}:${m.score.away}</span>`;
  else center = `<span class="final final-time num">${timeFmt.format(new Date(m.utcDate))}</span>`;
  const status = LIVE.includes(m.status) ? '<span class="status live-sub"><i class="dot"></i>Идёт матч</span>'
    : m.status === 'FINISHED' ? '<span class="status">Матч окончен · счёт основного времени</span>'
      : m.status === 'POSTPONED' ? '<span class="status">Матч перенесён</span>'
        : '<span class="status">Приём прогнозов закрыт</span>';
  let mine;
  if (!p) mine = '<div class="mine mine-empty">Ты не делал прогноз</div>';
  else {
    const exact = p.points != null && m.score && p.home === m.score.home && p.away === m.score.away;
    const pts = p.points == null ? '<span class="muted">ждём финал</span>' : `<b class="num ${p.points > 0 ? 'pts-hit' : ''}">+${p.points}</b>`;
    mine = `<div class="mine${exact ? ' mine-exact' : ''}"><span class="muted small">Мой прогноз</span><span class="num mine-score">${p.home}:${p.away}</span>${pts}${exact ? '<span class="stamp">ТОЧНЯК!</span>' : ''}</div>`;
  }
  $('sheet-body').innerHTML = `${teamsHead(m, center)}${status}${mine}
    <button type="button" class="btn btn-glass" data-close>Закрыть</button>`;
}

$('sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) { closeSheet(); return; }
  const s = state.sheet;
  if (!s) return;
  const step = e.target.closest('[data-step]');
  if (step) {
    const [side, delta] = step.dataset.step.split(':');
    s[side] = Math.max(0, Math.min(15, s[side] + Number(delta)));
    haptic('select');
    renderSheet();
    return;
  }
  const quick = e.target.closest('[data-quick]');
  if (quick) {
    const [h, a] = quick.dataset.quick.split(':').map(Number);
    s.home = h; s.away = a;
    haptic('select');
    renderSheet();
    return;
  }
  if (e.target.closest('#save-btn')) savePrediction();
});

async function savePrediction() {
  const s = state.sheet;
  const btn = $('save-btn');
  btn.disabled = true;
  try {
    await api('/api/predictions', { method: 'POST', body: { matchId: s.match.id, home: s.home, away: s.away } });
    s.match.prediction = { home: s.home, away: s.away, points: null };
    haptic('success');
    closeSheet();
    if (state.view === 'matches') renderMatches(); else loadMy();
    toast(`Залочено ${s.home}:${s.away}`);
  } catch (err) {
    $('sheet-error').textContent = err.message;
    $('sheet-error').hidden = false;
    btn.disabled = false;
    haptic('error');
    if (err.code === 'locked') { s.match.open = false; loadMatches(); }
  }
}

// ---------- Мои прогнозы ----------

async function loadMy() {
  if (!state.my.length) $('my-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api('/api/my');
    state.my = data.items;
    renderMy();
  } catch (err) {
    $('my-list').innerHTML = `<div class="glass empty"><b>Не загрузилось</b>${esc(err.message)}</div>`;
  }
}

function isDone(m) { return m.prediction && m.prediction.points != null; }

function renderMy() {
  const done = state.my.filter(isDone);
  const wait = state.my.filter((m) => !isDone(m)).reverse();
  const exact = done.filter((m) => m.score && m.prediction.home === m.score.home && m.prediction.away === m.score.away).length;
  const hits = done.filter((m) => m.prediction.points > 0).length;
  $('my-stats').innerHTML = `<div class="glass strip">
    <span><b class="num">${exact}</b><span>точняков</span></span>
    <span><b class="num">${hits}</b><span>в плюс</span></span>
    <span><b class="num">${wait.length}</b><span>ждут</span></span>
  </div>`;
  const items = state.mytab === 'wait' ? wait : done;
  if (!items.length) {
    $('my-list').innerHTML = state.mytab === 'wait'
      ? '<div class="glass empty"><b>Нет открытых прогнозов</b><button type="button" class="btn btn-primary btn-inline" data-go="matches">К матчам</button></div>'
      : '<div class="glass empty"><b>Пока ничего не сыграно</b>Итоги появятся после финального свистка</div>';
    return;
  }
  $('my-list').innerHTML = `<div class="glass list-card">${items.map(myRow).join('')}</div>`;
}

function myRow(m) {
  const p = m.prediction;
  const exact = isDone(m) && m.score && p.home === m.score.home && p.away === m.score.away;
  let right;
  if (isDone(m)) right = `<span class="my-pts ${p.points > 0 ? 'pts-hit' : 'pts-zero'} num">+${p.points}</span>`;
  else if (m.open) right = '<span class="tag tag-open">Изменить</span>';
  else right = `<span class="tag tag-none">${LIVE.includes(m.status) ? 'идёт' : 'ждём'}</span>`;
  const sub = isDone(m) ? `счёт ${m.score.home}:${m.score.away}` : whenShort(m.utcDate);
  return `<button type="button" class="match-row" data-match="${m.id}" aria-label="${esc(`${m.home.short} — ${m.away.short}`)}">
    <span class="pair">${crest(m.home)}<span class="mid"><span class="mid-main num">${p.home}:${p.away}</span><span class="mid-sub">${esc(sub)}</span></span>${crest(m.away)}</span>
    ${exact ? '<span class="stamp stamp-sm">ТОЧНЯК!</span>' : ''}
    ${right}
  </button>`;
}

// ---------- Друзья ----------

async function loadFriends() {
  $('friends-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api(`/api/friends?period=${state.fperiod}`);
    state.friendLink = data.shareLink || data.link;
    if (data.rows.length <= 1) {
      $('friends-list').innerHTML = `<div class="glass empty friends-empty">
        <svg class="ic ic-xl" aria-hidden="true"><use href="#i-users"/></svg>
        <b>Тут будет ваша лига</b>Позови друзей и смотри, кто точнее</div>`;
      return;
    }
    $('friends-list').innerHTML = `<div class="glass list-card">${data.rows.map((r) => `
      <div class="lb-row${r.isMe ? ' me' : ''}">
        <span class="lb-rank num">${r.rank}</span>
        <span class="avatar avatar-sm" aria-hidden="true">${esc(initials(r.name))}</span>
        <span class="lb-name">${r.isMe ? 'Ты' : esc(r.name)}</span>
        <span class="lb-pts num">${r.pts}</span>
        ${r.isMe ? '<span class="lb-act"></span>' : `<button type="button" class="icon-btn icon-btn-flat lb-act" data-friend="${esc(r.code)}" data-name="${esc(r.name)}" aria-label="Убрать ${esc(r.name)} из друзей">${icon('i-x')}</button>`}
      </div>`).join('')}</div>`;
  } catch (err) {
    $('friends-list').innerHTML = `<div class="glass empty"><b>Не загрузилось</b>${esc(err.message)}</div>`;
  }
}

async function friendLink() {
  if (!state.friendLink) {
    const data = await api('/api/friends');
    state.friendLink = data.shareLink || data.link;
  }
  return state.friendLink;
}

const INVITE_TEXT = 'Бросаю тебе вызов в Точняке 🎯 Угадываем счёт матчей, в конце недели смотрим, кто точнее';

// Приглашение с картинкой и кнопкой. Если Telegram старый, отправляем ссылку с превью.
$('invite-btn').addEventListener('click', async () => {
  const btn = $('invite-btn');
  btn.disabled = true;
  haptic('light');
  try {
    if (tg && tg.shareMessage && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
      try {
        const prepared = await api('/api/invite', { method: 'POST' });
        tg.shareMessage(prepared.id, (sent) => { if (sent) { haptic('success'); toast('Вызов отправлен'); } });
        return;
      } catch { /* ниже запасной вариант */ }
    }
    const link = await friendLink();
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(INVITE_TEXT)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(share);
    else window.open(share, '_blank');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('copy-btn').addEventListener('click', async () => {
  try {
    const link = await friendLink();
    await navigator.clipboard.writeText(link);
    haptic('success');
    toast('Ссылка скопирована');
  } catch { toast('Не получилось скопировать'); }
});

async function removeFriend(code, name) {
  const ok = await confirmDialog(`Убрать ${name} из друзей?`);
  if (!ok) return;
  try {
    await api(`/api/friends?code=${encodeURIComponent(code)}`, { method: 'DELETE' });
    haptic('success');
    loadFriends();
  } catch (err) { toast(err.message); }
}

// ---------- Рейтинг ----------

async function loadRating() {
  $('rating-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api(`/api/leaderboard?period=${state.period}`);
    const me = data.me;
    $('rating-me').innerHTML = `<div class="glass strip">
      <span><b class="num">${me.rank || '—'}</b><span>место</span></span>
      <span><b class="num">${me.pts}</b><span>${state.period === 'week' ? 'аура за неделю' : 'аура всего'}</span></span>
    </div>`;
    if (!data.rows.length) {
      $('rating-list').innerHTML = '<div class="glass empty"><b>Таблица пустая</b>Первые очки появятся после ближайших матчей</div>';
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
  $('friends-count').textContent = p.friendsCount ? p.friendsCount : '';
  $('profile-card').innerHTML = `<div class="glass profile-card">
    <div class="profile-head"><span class="avatar" aria-hidden="true">${esc(initials(p.firstName))}</span>
      <b>${esc(p.firstName || 'Игрок')}</b></div>
    <div class="strip strip-flat">
      <span><b class="num">${p.aura}</b><span>аура</span></span>
      <span><b class="num">${p.weekAura}</b><span>за неделю</span></span>
      <span><b class="num">${p.exactHits}</b><span>точняков</span></span>
      <span><b class="num">${p.settledPredictions}</b><span>сыграно</span></span>
    </div>
  </div>`;
}

$('rules-btn').addEventListener('click', () => {
  const rows = [['Точный счёт', '+10', '+5'], ['Разница мячей', '+6', '+3'], ['Исход', '+3', '+2'], ['Обе забьют / нет', '+1', ''], ['Тотал 2,5', '+1', ''], ['Редкий исход', '×1,5–×2', ''], ['Друг по твоей ссылке', '', '+10']];
  $('sheet-meta').innerHTML = '<span class="league-tag">Аура и монеты</span>';
  $('sheet-body').innerHTML = `<div class="glass list-card">${['<div class="rule-row rule-head"><span></span><span>аура</span><span>монеты</span></div>'].concat(rows.map(([a, b, c]) => `<div class="rule-row"><span>${a}</span><b class="num">${b}</b><b class="num coin-val">${c}</b></div>`)).join('')}</div>
    <p class="sheet-foot">Считается основное время. Приём закрывается за 5 минут до матча.</p>
    <a class="btn btn-glass" href="/terms.html">Все правила</a>`;
  state.sheet = { rules: true };
  $('sheet').hidden = false;
  syncBackButton();
  haptic('light');
});

function confirmDialog(text) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm) {
      try { tg.showConfirm(text, (ok) => resolve(Boolean(ok))); return; } catch { /* ниже запасной вариант */ }
    }
    resolve(window.confirm(text));
  });
}

$('delete-btn').addEventListener('click', async () => {
  const ok = await confirmDialog('Удалить аккаунт? Аура, прогнозы, друзья и место в рейтинге сотрутся навсегда.');
  if (!ok) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    haptic('success');
    state.profile = null;
    state.matches = [];
    state.my = [];
    $('login-name').textContent = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.first_name : 'Игрок';
    showGate('gate-login');
    toast('Аккаунт удалён');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Гардероб (превью, вещи появятся позже) ----------

function renderWardrobe() {
  $('wardrobe-tabs').innerHTML = WARDROBE.map((c) => `<button type="button" class="chip chip-icon" role="tab" data-wtab="${c.id}" aria-selected="${state.wardrobe === c.id}">${icon(c.icon)}${esc(c.label)}</button>`).join('');
  const cat = WARDROBE.find((c) => c.id === state.wardrobe);
  $('wardrobe-items').innerHTML = Array.from({ length: 6 }, (_, i) => `
    <div class="glass item${i === 0 ? ' item-on' : ''}">
      <svg class="ic ic-item" aria-hidden="true"><use href="#${cat.icon}"/></svg>
      ${i === 0 ? '<span class="item-tag">надето</span>' : `<span class="item-lock">${icon('i-lock')}<span class="num">${(i + 1) * 50}</span></span>`}
    </div>`).join('');
}

boot();
