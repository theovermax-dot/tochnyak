// Точняк: клиент мини-аппа. Без сборки и зависимостей, только Telegram WebApp SDK.

import { LEGAL } from './legal.js';

const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';

const LEAGUES = {
  PL: 'АПЛ', PD: 'Ла Лига', SA: 'Серия А', BL1: 'Бундеслига', FL1: 'Лига 1', CL: 'Лига чемпионов', DED: 'Эредивизи'
};
const LEAGUE_ORDER = ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'DED'];
const QUICK_SCORES = [[1, 0], [2, 0], [2, 1], [1, 1], [0, 0], [0, 1], [1, 2], [3, 1], [2, 2], [0, 2]];
const LIVE = ['IN_PLAY', 'PAUSED'];


const state = {
  profile: null,
  matches: [],
  my: [],
  league: 'ALL',
  period: 'week',
  fperiod: 'week',
  mytab: 'wait',
  shop: null,
  shopPick: null,
  view: 'matches',
  sheet: null,
  friendLink: null,
  pendingRef: null,
  battles: [],
  battle: null,
  draft: null
};

const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};
const ENDED = ['FINISHED', 'CANCELLED', 'AWARDED'];

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
// Только логотип. Буквы команды показываем, лишь если логотипа нет или он не загрузился.
function crest(team, size = '') {
  const inner = team.crest
    ? `<img src="${esc(team.crest)}" alt="" loading="lazy" decoding="async" data-tla="${esc(team.tla)}">`
    : `<span class="crest-tla">${esc(team.tla)}</span>`;
  return `<span class="crest ${size}" title="${esc(team.short)}">${inner}</span>`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.parentElement || !img.parentElement.classList.contains('crest')) return;
  const tla = document.createElement('span');
  tla.className = 'crest-tla';
  tla.textContent = img.dataset.tla || '';
  img.replaceWith(tla);
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
    // Полный экран везде, где Telegram это умеет: телефоны, Telegram Desktop и macOS.
    if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen && !tg.isFullscreen) tg.requestFullscreen();
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
  const show = !$('sheet').hidden || SUBVIEWS[state.view];
  try { show ? tg.BackButton.show() : tg.BackButton.hide(); } catch { /* старые клиенты */ }
}

function onBack() {
  if (!$('sheet').hidden) closeSheet();
  else if (SUBVIEWS[state.view]) go(SUBVIEWS[state.view]);
}

// ---------- Вход ----------

function showGate(which) {
  for (const id of ['gate-loading', 'gate-outside', 'gate-login', 'gate-phone', 'gate-error']) $(id).hidden = id !== which;
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
      openLegalFromHash();
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
    if (!res.profile.hasPhone && canRequestContact()) askPhone(res.profile);
    else await enterApp(res.profile);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
    haptic('error');
  } finally {
    btn.disabled = !$('consent').checked;
  }
});

$('consent').addEventListener('change', () => {
  $('login-btn').disabled = !$('consent').checked;
  haptic('select');
});

$('retry-btn').addEventListener('click', boot);

// ---------- Номер телефона: необязательно, чтобы друзья нашли по номеру ----------

const canRequestContact = () => Boolean(tg && tg.requestContact && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9'));

function askPhone(profile) {
  state.profile = profile;
  $('phone-username').textContent = profile.username ? `@${profile.username}` : 'имени';
  showGate('gate-phone');
}

// Telegram сам показывает окно «Поделиться номером» и присылает номер боту. Ждём, пока сервер его запишет.
function requestPhone() {
  return new Promise((resolve) => {
    if (!canRequestContact()) { resolve(false); return; }
    try {
      tg.requestContact(async (shared) => {
        if (!shared) { resolve(false); return; }
        for (let i = 0; i < 8; i += 1) {
          await new Promise((r) => setTimeout(r, 700));
          try {
            const me = await api('/api/me');
            if (me.profile && me.profile.hasPhone) { state.profile = me.profile; resolve(true); return; }
          } catch { /* ещё раз */ }
        }
        resolve(false);
      });
    } catch { resolve(false); }
  });
}

$('phone-btn').addEventListener('click', async () => {
  const btn = $('phone-btn');
  btn.disabled = true;
  const ok = await requestPhone();
  btn.disabled = false;
  if (ok) { haptic('success'); toast('Номер привязан'); }
  await enterApp(state.profile);
});
$('phone-skip').addEventListener('click', () => enterApp(state.profile));

async function enterApp(profile) {
  state.profile = profile;
  renderTop();
  $('gate').hidden = true;
  $('app').hidden = false;
  const battle = /^#battle-([a-z0-9]{10})$/.exec(location.hash);
  if (battle) openBattle(battle[1]);
  else go(location.hash === '#profile' ? 'profile' : location.hash === '#friends' ? 'friends' : 'matches');
  openLegalFromHash();
  clearHash();
  if (state.pendingRef) acceptInvite(state.pendingRef);
  loadBattles();
}

function clearHash() {
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* не страшно */ }
}

function openLegalFromHash() {
  const h = location.hash;
  if (h === '#terms' || h === '#legal') openLegal('terms');
  if (h === '#privacy') openLegal('privacy');
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
  $('shop-coins').textContent = (p.coins || 0).toLocaleString('ru-RU');
  $('top-avatar').textContent = initials(p.firstName);
}

// ---------- Навигация ----------

const VIEWS = ['matches', 'my', 'friends', 'rating', 'profile', 'shop', 'battle', 'battle-new'];
// Вложенные экраны и куда с них возвращаться.
const SUBVIEWS = { shop: 'profile', battle: 'friends', 'battle-new': 'friends' };

function go(view) {
  if (!$('sheet').hidden) closeSheet();
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  const tab = SUBVIEWS[view] || view;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.go === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  syncBackButton();
  if (view === 'matches') loadMatches();
  if (view === 'my') loadMy();
  if (view === 'friends') { loadFriends(); loadBattles(); }
  if (view === 'rating') loadRating();
  if (view === 'profile') loadProfile();
  if (view === 'shop') loadShop();
}

function setSelected(attr, value) {
  document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.setAttribute('aria-selected', String(x.dataset[attr] === value)));
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const legal = t.closest('[data-legal]');
  if (legal) { e.preventDefault(); openLegal(legal.dataset.legal); return; }
  if (t.closest('[data-econ]')) { openEcon(); return; }
  if (t.closest('[data-add-friend]')) { openAddFriend(); return; }
  const st = t.closest('[data-st]');
  if (st) { stepPick(st.dataset.st); return; }
  const draft = t.closest('[data-draft]');
  if (draft) { toggleDraft(Number(draft.dataset.draft)); return; }
  const challenge = t.closest('[data-challenge]');
  if (challenge) { newBattle(challenge.dataset.challenge, challenge.dataset.name); return; }
  const battleEl = t.closest('[data-battle]');
  if (battleEl) { haptic('light'); openBattle(battleEl.dataset.battle); return; }
  const bact = t.closest('[data-bact]');
  if (bact) { battleAction(bact.dataset.bact); return; }
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
  const pick = t.closest('[data-pick]');
  if (pick) { state.shopPick = pick.dataset.pick; haptic('select'); renderShop(); return; }
  const shopAct = t.closest('[data-shop]');
  if (shopAct) { shopAction(shopAct.dataset.shop, shopAct.dataset.id); return; }
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

// Короткая подпись для узких строк: «16:00», «завтра 16:00», «2 нояб. 16:00». Что это МСК, сказано в шапке списка.
function whenTiny(date) {
  const diff = dayDiff(date);
  const t = timeFmt.format(new Date(date));
  if (diff === 0) return t;
  if (diff === 1) return `завтра ${t}`;
  if (diff === -1) return `вчера ${t}`;
  return `${shortDayFmt.format(new Date(date))} ${t}`;
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
  // Сыгранные матчи тут не нужны: итоги лежат во вкладке «Мои → Сыграны».
  const all = state.matches.filter((m) => !ENDED.includes(m.status));
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

// Награда за точный счёт: 10 за счёт + по 1 за «обе забьют» и тотал, которые при точном счёте угаданы всегда.
// Должно совпадать с src/scoring.js. Редкий исход может дать ещё больше.
const PRIZE = { aura: 12, coins: 5 };

function prize(m) {
  if (!m.open) return '<span class="prize" aria-hidden="true"></span>';
  return `<span class="prize" title="Столько дадут за точный счёт">
    <span class="prize-l">за точный счёт</span>
    <span class="prize-v"><span class="prize-a num"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg>+${PRIZE.aura}</span><span class="prize-c num"><span class="coin" aria-hidden="true"></span>+${PRIZE.coins}</span></span>
  </span>`;
}

function matchRow(m) {
  const label = `${m.home.short} — ${m.away.short}, ${league(m)}`;
  return `<button type="button" class="match-row" data-match="${m.id}" aria-label="${esc(label)}">
    <span class="pair">${crest(m.home)}${centerCell(m)}${crest(m.away)}</span>
    ${prize(m)}
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
    <div class="prize-line">Угадаешь точно: <b class="num prize-a"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg>+${PRIZE.aura} ауры</b> и <b class="num prize-c"><span class="coin" aria-hidden="true"></span>+${PRIZE.coins} монет</b></div>
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
  $('my-list').innerHTML = (state.mytab === 'wait' ? `<p class="tz-note">${icon('i-clock')}Крупно твой прогноз, ниже время матча по МСК</p>` : '')
    + `<div class="glass list-card">${items.map(myRow).join('')}</div>`;
}

function myRow(m) {
  const p = m.prediction;
  const exact = isDone(m) && m.score && p.home === m.score.home && p.away === m.score.away;
  let right;
  if (isDone(m)) right = `<span class="my-pts ${p.points > 0 ? 'pts-hit' : 'pts-zero'} num">+${p.points}</span>`;
  else if (m.open) right = '<span class="tag tag-open">Изменить</span>';
  else right = `<span class="tag tag-none">${LIVE.includes(m.status) ? 'идёт' : 'ждём'}</span>`;
  const sub = isDone(m) ? `счёт ${m.score.home}:${m.score.away}`
    : LIVE.includes(m.status) ? (m.score ? `сейчас ${m.score.home}:${m.score.away}` : 'идёт') : whenTiny(m.utcDate);
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
        <b>Тут будет ваша лига</b>Найди друга по @username или номеру, или позови по ссылке
        <button type="button" class="btn btn-primary btn-inline" data-add-friend>${icon('i-user-plus')}Добавить друга</button></div>`;
      return;
    }
    $('friends-list').innerHTML = `<div class="glass list-card">${data.rows.map((r) => `
      <div class="lb-row${r.isMe ? ' me' : ''}">
        <span class="lb-rank num">${r.rank}</span>
        <span class="avatar avatar-sm" aria-hidden="true">${esc(initials(r.name))}</span>
        <span class="lb-name">${r.isMe ? 'Ты' : esc(r.name)}</span>
        <span class="lb-pts num">${r.pts}</span>
        ${r.isMe ? '<span class="fight-btn fight-btn-ghost" aria-hidden="true"></span>' : `<button type="button" class="fight-btn" data-challenge="${esc(r.code)}" data-name="${esc(r.name)}" aria-label="Бой с ${esc(r.name)}">${icon('i-swords')}Бой</button>`}
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

// Приглашение с картинкой и кнопкой. На телефоне — готовое сообщение через Telegram,
// на компьютере и если что-то пошло не так — обычное окно «Поделиться» со ссылкой.
const DESKTOP = ['tdesktop', 'macos', 'weba', 'webk', 'web', 'unknown'];
let shareFallback = null;
if (tg && tg.onEvent) {
  try { tg.onEvent('shareMessageFailed', () => { if (shareFallback) { const f = shareFallback; shareFallback = null; f(); } }); } catch { /* старые клиенты */ }
}

async function shareLink() {
  const link = await friendLink();
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(INVITE_TEXT)}`;
  if (tg && tg.openTelegramLink) tg.openTelegramLink(share);
  else window.open(share, '_blank');
}

async function shareInvite() {
  haptic('light');
  const rich = tg && tg.shareMessage && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && !DESKTOP.includes(tg.platform);
  if (rich) {
    try {
      const prepared = await api('/api/invite', { method: 'POST' });
      shareFallback = () => { shareLink().catch((err) => toast(err.message)); };
      tg.shareMessage(prepared.id, (sent) => {
        shareFallback = null;
        if (sent) { haptic('success'); toast('Вызов отправлен'); }
      });
      return;
    } catch { shareFallback = null; /* ниже обычная ссылка */ }
  }
  await shareLink();
}

$('invite-btn').addEventListener('click', async () => {
  const btn = $('invite-btn');
  btn.disabled = true;
  try { await shareInvite(); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});

// Добавить друга по @username или номеру.
function openAddFriend() {
  const p = state.profile || {};
  const me = p.username ? `<b>@${esc(p.username)}</b>` : '<span class="muted">username не задан в Telegram</span>';
  openPanel('<span class="league-tag">Добавить друга</span>', `
    <form id="find-form" class="find" autocomplete="off">
      <label class="find-field"><svg class="ic" aria-hidden="true"><use href="#i-users"/></svg>
        <input id="find-q" type="text" inputmode="text" enterkeyhint="search" placeholder="@username или номер" aria-label="Username или номер друга" maxlength="40"></label>
      <button type="submit" class="btn btn-primary" id="find-btn">${icon('i-user-plus')}Найти и добавить</button>
      <p id="find-msg" class="find-msg" role="status" hidden></p>
    </form>
    <div class="glass list-card">
      <div class="me-row"><span class="me-row-l">Тебя найдут по</span>${me}</div>
      <div class="me-row"><span class="me-row-l">Номер телефона</span>${p.hasPhone
        ? `<span class="me-ok">${icon('i-check')}привязан <button type="button" class="link link-sm" id="unlink-phone">отвязать</button></span>`
        : canRequestContact() ? '<button type="button" class="link" id="link-phone">Привязать</button>' : '<span class="muted">не привязан</span>'}</div>
    </div>
    <p class="sheet-foot">Друга ещё нет в Точняке? Отправь ему приглашение.</p>
    <button type="button" class="btn btn-glass" id="sheet-invite">${icon('i-share')}Позвать по ссылке</button>`, { addFriend: true });
  setTimeout(() => { try { $('find-q').focus(); } catch { /* не страшно */ } }, 250);
}

$('add-friend-btn').addEventListener('click', openAddFriend);

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'find-form') return;
  e.preventDefault();
  const q = $('find-q').value.trim();
  const msg = $('find-msg');
  if (!q) { $('find-q').focus(); return; }
  $('find-btn').disabled = true;
  msg.hidden = true;
  try {
    const res = await api('/api/friends/find', { method: 'POST', body: { query: q } });
    haptic('success');
    msg.className = 'find-msg ok';
    msg.textContent = res.added ? `${res.name} теперь у тебя в друзьях` : `${res.name} уже у тебя в друзьях`;
    msg.hidden = false;
    $('find-q').value = '';
    if (state.view === 'friends') loadFriends();
  } catch (err) {
    haptic('error');
    msg.className = 'find-msg bad';
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    $('find-btn').disabled = false;
  }
});

document.addEventListener('click', async (e) => {
  if (e.target.closest('#sheet-invite')) { try { await shareInvite(); } catch (err) { toast(err.message); } return; }
  if (e.target.closest('#unlink-phone')) {
    if (!(await confirmDialog('Отвязать номер? Друзья больше не найдут тебя по нему.'))) return;
    try {
      await api('/api/me/phone', { method: 'DELETE' });
      if (state.profile) state.profile.hasPhone = false;
      toast('Номер отвязан');
      openAddFriend();
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('#link-phone')) {
    const ok = await requestPhone();
    if (ok) { haptic('success'); toast('Номер привязан'); openAddFriend(); }
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
    <div class="hero-dude">
      <span class="dude-glow" aria-hidden="true"></span>
      <div class="spin" data-spin="${esc(p.character || 'tochnyak')}" role="img" aria-label="Твой персонаж: крути пальцем влево и вправо"></div>
      <button type="button" class="dude-btn" data-go="shop">${icon('i-bag')}Магазин</button>
    </div>
    <div class="profile-name"><b>${esc(p.firstName || 'Игрок')}</b>
      <button type="button" class="profile-wallet" data-econ aria-label="Что такое монеты и аура"><span class="stat-chip"><span class="coin" aria-hidden="true"></span><span class="num">${p.coins || 0}</span></span>
      <span class="stat-chip"><svg class="ic ic-aura" aria-hidden="true"><use href="#i-target"/></svg><span class="num">${p.aura}</span></span><svg class="ic ic-info" aria-hidden="true"><use href="#i-info"/></svg></button></div>
    <div class="strip strip-flat">
      <span><b class="num">${p.weekAura}</b><span>за неделю</span></span>
      <span><b class="num">${p.exactHits}</b><span>точняков</span></span>
      <span><b class="num">${p.settledPredictions}</b><span>сыграно</span></span>
    </div>
  </div>`;
  mountSpinners();
}

// ---------- Окна: аура и монеты, правила ----------

function openPanel(meta, body, sheetState) {
  $('sheet-meta').innerHTML = meta;
  $('sheet-body').innerHTML = body;
  state.sheet = sheetState;
  const wasHidden = $('sheet').hidden;
  $('sheet').hidden = false;
  if (wasHidden) haptic('light');
  $('sheet').querySelector('.sheet-panel').scrollTop = 0;
  syncBackButton();
}

const EARN = [
  ['Точный счёт', '+10', '+5'],
  ['Разница мячей', '+6', '+3'],
  ['Только исход', '+3', '+2'],
  ['Обе забьют / нет', '+1', ''],
  ['Тотал 2,5', '+1', ''],
  ['Редкий исход', '×1,5–×2', ''],
  ['Друг по твоей ссылке', '', '+10']
];

function openEcon() {
  const p = state.profile || { aura: 0, coins: 0 };
  const inShop = state.view === 'shop';
  openPanel('<span class="league-tag">Аура и монеты</span>', `
    <div class="econ">
      <div class="econ-card econ-aura">
        <div class="econ-top"><span class="econ-ic"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg></span><b>Аура</b><span class="num econ-val">${p.aura.toLocaleString('ru-RU')}</span></div>
        <p>Очки за точность. По ауре строится рейтинг недели и всего времени: чем точнее прогнозы, тем выше ты среди друзей и всех игроков.</p>
        <span class="econ-note">Никогда не тратится</span>
      </div>
      <div class="econ-card econ-coins">
        <div class="econ-top"><span class="econ-ic"><span class="coin" aria-hidden="true"></span></span><b>Монеты</b><span class="num econ-val">${(p.coins || 0).toLocaleString('ru-RU')}</span></div>
        <p>Валюта для магазина: на монеты покупаешь новых персонажей. На рейтинг не влияют.</p>
        <span class="econ-note">Не покупаются за деньги и не выводятся</span>
      </div>
    </div>
    <div class="glass list-card">${['<div class="rule-row rule-head"><span>Как заработать</span><span>аура</span><span>монеты</span></div>']
      .concat(EARN.map(([a, b, c]) => `<div class="rule-row"><span>${a}</span><b class="num">${b}</b><b class="num coin-val">${c}</b></div>`)).join('')}</div>
    <p class="sheet-foot">Считается основное время. Приём прогнозов закрывается за 5 минут до матча.</p>
    ${inShop ? '' : `<button type="button" class="btn btn-primary" data-go="shop">${icon('i-bag')}В магазин</button>`}
    <button type="button" class="btn btn-glass" data-legal="terms">Все правила</button>`, { econ: true });
}

function openLegal(tab) {
  const key = tab === 'privacy' ? 'privacy' : 'terms';
  const doc = LEGAL[key];
  const atGate = !$('gate').hidden;
  openPanel('<span class="league-tag">Документы</span>', `
    <div class="glass segmented" role="tablist">
      <button type="button" role="tab" data-legal="terms" aria-selected="${key === 'terms'}">Правила</button>
      <button type="button" role="tab" data-legal="privacy" aria-selected="${key === 'privacy'}">Конфиденциальность</button>
    </div>
    <article class="doc"><h3>${esc(doc.title)}</h3>${doc.html}</article>
    <button type="button" class="btn ${atGate ? 'btn-primary' : 'btn-glass'}" data-close${atGate ? ' data-agree' : ''}>${atGate ? 'Понятно, принимаю' : 'Закрыть'}</button>`, { legal: key });
}

// «Понятно, принимаю» в окне правил на экране входа ставит галочку за игрока.
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-agree]')) return;
  $('consent').checked = true;
  $('login-btn').disabled = false;
}, true);

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
    state.battles = [];
    $('consent').checked = false;
    $('login-btn').disabled = true;
    $('login-name').textContent = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.first_name : 'Игрок';
    showGate('gate-login');
    toast('Аккаунт удалён');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Магазин персонажей ----------

const SOON_SLOTS = 3; // карточки «скоро», пока новых персонажей нет

async function loadShop() {
  if (!state.shop) $('shop-grid').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    state.shop = await api('/api/shop');
    if (!state.shopPick || !state.shop.items.some((i) => i.id === state.shopPick)) state.shopPick = state.shop.selected;
    renderShop();
  } catch (err) {
    $('shop-grid').innerHTML = `<div class="glass empty"><b>Магазин не загрузился</b>${esc(err.message)}</div>`;
  }
}

function shopButton(item, coins) {
  if (item.selected) return `<button type="button" class="btn btn-glass" disabled>${icon('i-check')}Выбран</button>`;
  if (item.owned) return `<button type="button" class="btn btn-primary" data-shop="select" data-id="${esc(item.id)}">Выбрать</button>`;
  if (coins < item.price) return `<button type="button" class="btn btn-glass" disabled><span class="coin" aria-hidden="true"></span><span class="num">${item.price}</span> · не хватает ${item.price - coins}</button>`;
  return `<button type="button" class="btn btn-primary" data-shop="buy" data-id="${esc(item.id)}">Купить за <span class="coin" aria-hidden="true"></span><span class="num">${item.price}</span></button>`;
}

function renderShop() {
  const shop = state.shop;
  if (!shop) return;
  $('shop-coins').textContent = shop.coins.toLocaleString('ru-RU');
  const item = shop.items.find((i) => i.id === state.shopPick) || shop.items[0];
  $('shop-stage').innerHTML = `<div class="glass shop-stage">
    <div class="shop-stage-art">
      <span class="dude-glow" aria-hidden="true"></span>
      <div class="spin" data-spin="${esc(item.id)}" role="img" aria-label="${esc(item.name)}: крути пальцем"></div>
    </div>
    <div class="shop-stage-info"><b>${esc(item.name)}</b><span class="rarity">${esc(item.rarity || '')}</span></div>
    ${shopButton(item, shop.coins)}
  </div>`;
  const cards = shop.items.map((i) => `
    <button type="button" class="glass shop-card${i.id === item.id ? ' picked' : ''}" data-pick="${esc(i.id)}" aria-pressed="${i.id === item.id}">
      <img src="/chars/${esc(i.id)}/front.webp" alt="" loading="lazy">
      <span class="shop-card-name">${esc(i.name)}</span>
      <span class="shop-card-price">${i.selected ? 'выбран' : i.owned ? 'есть' : `<span class="coin" aria-hidden="true"></span><span class="num">${i.price}</span>`}</span>
    </button>`);
  for (let k = 0; k < SOON_SLOTS; k += 1) {
    cards.push(`<div class="glass shop-card soon" aria-label="Скоро новый персонаж">
      <span class="silhouette" aria-hidden="true"></span>
      <span class="shop-card-name">Скоро</span>
      <span class="shop-card-price">${icon('i-lock')}</span>
    </div>`);
  }
  $('shop-grid').innerHTML = cards.join('');
  mountSpinners();
}

async function shopAction(action, id) {
  const ok = action === 'buy'
    ? await confirmDialog(`Купить «${state.shop.items.find((i) => i.id === id).name}»? Монеты спишутся, аура и рейтинг не изменятся.`)
    : true;
  if (!ok) return;
  try {
    state.shop = await api(`/api/shop/${action}`, { method: 'POST', body: { id } });
    haptic('success');
    if (state.profile) { state.profile.coins = state.shop.coins; state.profile.character = state.shop.selected; renderTop(); }
    toast(action === 'buy' ? 'Персонаж твой' : 'Персонаж выбран');
    renderShop();
  } catch (err) {
    haptic('error');
    toast(err.message);
  }
}


// ---------- Бои с друзьями ----------
// Двое ставят свои счета на одни и те же матчи. На интерес: аура и монеты за бой не начисляются.

const BATTLE_MAX = 10;
const BATTLE_RULE = 'Точный счёт 3 · разница 2 · исход 1. На интерес: аура и монеты не начисляются.';

async function loadBattles() {
  try {
    const data = await api('/api/battles');
    state.battles = data.battles;
  } catch { return; }
  $('tab-dot').hidden = !state.battles.some((b) => b.needsMyPicks);
  if (state.view === 'friends') renderBattles();
}

function battleLabel(b) {
  if (b.status === 'done') {
    if (b.result === 'win') return ['Победа', 'win'];
    if (b.result === 'lose') return ['Поражение', 'lose'];
    return ['Ничья', 'draw'];
  }
  if (b.status === 'declined') return [b.role === 'creator' ? 'Отказался' : 'Ты отказался', 'mute'];
  if (b.status === 'cancelled') return ['Отменён', 'mute'];
  if (b.status === 'expired') return ['Не состоялся', 'mute'];
  if (b.needsMyPicks) return [b.status === 'pending' ? 'Тебя вызвали' : 'Поставь счёт', 'hot'];
  if (b.status === 'pending') return ['Ждём ответа', 'mute'];
  return ['Идёт', 'live'];
}

function renderBattles() {
  const list = state.battles;
  if (!list.length) {
    $('battles-list').innerHTML = `<div class="glass battle-promo">
      <span class="battle-promo-ic">${icon('i-swords')}</span>
      <span><b>Бой с другом</b><span class="muted small">Выберите матчи, поставьте разные счета и посмотрите, кто точнее. Нажми «Бой» рядом с другом.</span></span>
    </div>`;
    return;
  }
  $('battles-list').innerHTML = `<section class="day">
    <h3 class="day-head"><span>Бои</span><span class="day-count num">${list.length}</span></h3>
    <div class="glass list-card">${list.map((b) => {
      const [label, cls] = battleLabel(b);
      const scored = b.status === 'done' || b.decided > 0;
      const sub = b.status === 'done' ? `${b.total} ${plural(b.total, ['матч', 'матча', 'матчей'])} сыграно`
        : `${b.total} ${plural(b.total, ['матч', 'матча', 'матчей'])}${b.decided ? ` · сыграно ${b.decided}` : ''}`;
      return `<button type="button" class="battle-row" data-battle="${esc(b.id)}">
        <span class="avatar avatar-sm" aria-hidden="true">${esc(initials(b.opponent.name))}</span>
        <span class="battle-row-main"><b>${esc(b.opponent.name)}</b><span>${esc(sub)}</span></span>
        ${scored ? `<span class="battle-row-score num">${b.score.me}:${b.score.them}</span>` : ''}
        <span class="bstate bstate-${cls}">${label}</span>
      </button>`;
    }).join('')}</div>
  </section>`;
}

// Маленький степпер счёта: ctx d — черновик нового боя, b — прогнозы в открытом бою.
function miniStep(ctx, id, side, value, name) {
  return `<span class="mstep">
    <button type="button" data-st="${ctx}:${id}:${side}:-1" aria-label="${esc(name)}: на гол меньше">−</button>
    <b class="num">${value}</b>
    <button type="button" data-st="${ctx}:${id}:${side}:1" aria-label="${esc(name)}: на гол больше">+</button>
  </span>`;
}

function stepPick(spec) {
  const [ctx, id, side, delta] = spec.split(':');
  const map = ctx === 'd' ? state.draft && state.draft.picks : state.battle && state.battle.edit;
  const p = map && map.get(Number(id));
  if (!p) return;
  p[side] = Math.max(0, Math.min(15, p[side] + Number(delta)));
  haptic('select');
  if (ctx === 'd') renderDraft(); else renderBattle();
}

// Новый бой: выбор матчей и свои счета.
async function newBattle(code, name) {
  haptic('light');
  state.draft = { code, name, picks: new Map() };
  go('battle-new');
  $('bn-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  renderDraft();
  try {
    const data = await api('/api/matches');
    state.matches = data.matches;
  } catch (err) {
    $('bn-list').innerHTML = `<div class="glass empty"><b>Матчи не загрузились</b>${esc(err.message)}</div>`;
    return;
  }
  renderDraft();
}

function toggleDraft(id) {
  const d = state.draft;
  if (!d) return;
  if (d.picks.has(id)) d.picks.delete(id);
  else if (d.picks.size >= BATTLE_MAX) { toast(`В бою максимум ${BATTLE_MAX} матчей`); haptic('error'); return; }
  else d.picks.set(id, { home: 1, away: 0 });
  haptic('select');
  renderDraft();
}

function draftRow(m, p) {
  const team = (side) => `<span class="prow-team">${crest(m[side])}<b>${esc(m[side].short)}</b>${p ? miniStep('d', m.id, side, p[side], m[side].short) : ''}</span>`;
  return `<div class="prow${p ? ' on' : ''}"${p ? '' : ` data-draft="${m.id}" role="button" tabindex="0" aria-label="${esc(`Добавить ${m.home.short} — ${m.away.short}`)}"`}>
    <button type="button" class="prow-tick" data-draft="${m.id}" aria-pressed="${Boolean(p)}" aria-label="${p ? 'Убрать матч' : 'Добавить матч'}">${icon('i-check')}</button>
    <span class="prow-teams">${team('home')}${team('away')}</span>
    ${p ? '' : `<span class="prow-time"><b class="num">${timeFmt.format(new Date(m.utcDate))}</b><span>${esc(league(m))}</span></span>`}
  </div>`;
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $('bn-friend').innerHTML = `<div class="glass versus-chip">
    <span class="avatar avatar-sm" aria-hidden="true">${esc(initials(state.profile && state.profile.firstName))}</span><b>Ты</b>
    <span class="vs-mark">${icon('i-swords')}</span>
    <b>${esc(d.name)}</b><span class="avatar avatar-sm" aria-hidden="true">${esc(initials(d.name))}</span>
  </div>
  <p class="hint">Отметь до ${BATTLE_MAX} матчей и поставь свои счета. ${esc(d.name)} поставит свои, а после матчей посмотрим, кто точнее. ${BATTLE_RULE}</p>`;
  const n = d.picks.size;
  $('bn-count').textContent = `${n} из ${BATTLE_MAX}`;
  $('bn-send').disabled = !n;
  $('bn-send').innerHTML = n ? `${icon('i-swords')}Бросить вызов · <span class="num">${n}</span>` : 'Выбери матчи';
  if (!state.matches.length) return;
  const open = state.matches.filter((m) => m.open);
  if (!open.length) {
    $('bn-list').innerHTML = '<div class="glass empty"><b>Сейчас нет матчей для боя</b>Загляни, когда появятся новые</div>';
    return;
  }
  const groups = [];
  for (const m of open) {
    const label = dayLabel(m.utcDate);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  $('bn-list').innerHTML = groups.map((g) => `<section class="day">
    <h3 class="day-head"><span>${esc(g.label)}</span><span class="day-count">МСК</span></h3>
    <div class="glass list-card">${g.items.map((m) => draftRow(m, d.picks.get(m.id))).join('')}</div>
  </section>`).join('');
}

$('bn-send').addEventListener('click', async () => {
  const d = state.draft;
  if (!d || !d.picks.size) return;
  const btn = $('bn-send');
  btn.disabled = true;
  try {
    const picks = [...d.picks].map(([matchId, p]) => ({ matchId, home: p.home, away: p.away }));
    const res = await api('/api/battles', { method: 'POST', body: { friend: d.code, picks } });
    haptic('success');
    toast(`Вызов отправлен: ${d.name}`);
    state.draft = null;
    openBattle(res.id);
    loadBattles();
  } catch (err) {
    haptic('error');
    toast(err.message);
    btn.disabled = false;
    if (err.code === 'locked') newBattle(d.code, d.name);
  }
});

// Открытый бой.
async function openBattle(id) {
  go('battle');
  $('battle-body').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    setBattle(await api(`/api/battles/${encodeURIComponent(id)}`));
    renderBattle();
  } catch (err) {
    $('battle-body').innerHTML = `<div class="glass empty"><b>Бой не открылся</b>${esc(err.message)}</div>`;
  }
}

function setBattle(data) {
  const b = data.battle;
  const canEdit = ['pending', 'active'].includes(b.status);
  const edit = new Map();
  if (canEdit) {
    for (const it of b.items) {
      if (it.open) edit.set(it.matchId, it.mine ? { home: it.mine.home, away: it.mine.away } : { home: 1, away: 0 });
    }
  }
  state.battle = { battle: b, matches: data.matches, edit };
}

function battleNote(b) {
  const name = esc(b.opponent.name);
  if (b.status === 'pending' && b.role === 'creator') return `Ждём, когда ${name} примет бой и поставит свои счета.`;
  if (b.status === 'pending') return `${name} вызывает тебя. Поставь свои счета и прими бой.`;
  if (b.status === 'active') return b.decided ? `Сыграно ${b.decided} из ${b.total}.` : 'Бой принят. Ждём матчи.';
  if (b.status === 'done') return b.result === 'win' ? 'Ты оказался точнее.' : b.result === 'lose' ? `${name} оказался точнее.` : 'Одинаково точно.';
  if (b.status === 'declined') return b.role === 'creator' ? `${name} отказался от боя.` : 'Ты отказался от этого боя.';
  return 'Матчи начались раньше, чем бой приняли.';
}

function battleItem(it, m, b, edit) {
  const e = edit.get(m.id);
  const finished = m.status === 'FINISHED' && m.score;
  let head;
  if (LIVE.includes(m.status)) head = `<span class="live-sub"><i class="dot"></i>идёт${m.score ? ` · <span class="num">${m.score.home}:${m.score.away}</span>` : ''}</span>`;
  else if (finished) head = `<span>матч окончен · <b class="num">${m.score.home}:${m.score.away}</b></span>`;
  else if (m.status === 'POSTPONED') head = '<span>перенесён</span>';
  else if (m.status === 'CANCELLED') head = '<span>отменён</span>';
  else head = `<span>${esc(whenShort(m.utcDate))}</span>`;

  const cell = (v) => `<b class="num pickv">${v}</b>`;
  const mine = (side) => (e ? miniStep('b', m.id, side, e[side], m[side].short) : cell(it.mine ? it.mine[side] : '—'));
  const t = it.theirs;
  let theirs;
  if (t && t.hidden) theirs = `<span class="bg-lock" title="Откроется, когда закроется приём">${icon('i-lock')}<span>скрыт</span></span>`;
  else if (t) theirs = `<span class="bg-c2 bg-r2">${cell(t.home)}</span><span class="bg-c2 bg-r3">${cell(t.away)}</span>`;
  else theirs = `<span class="bg-lock bg-none">${it.open ? 'ждём' : '—'}</span>`;
  const exact = (x) => Boolean(finished && x && x.home === m.score.home && x.away === m.score.away);
  const pts = (x) => (x && x.pts != null
    ? `<span class="bpts${x.pts > 0 ? ' hit' : ''}${exact(x) ? ' exact' : ''} num">${exact(x) ? 'точно ' : ''}+${x.pts}</span>` : '');
  const showPts = finished && ((it.mine && it.mine.pts != null) || (t && !t.hidden && t.pts != null));
  return `<div class="brow">
    <div class="brow-head"><span class="league-tag">${esc(league(m))}</span>${head}</div>
    <div class="bgrid${e ? ' editing' : ''}">
      <span class="bg-h bg-c1">Ты</span><span class="bg-h bg-c2">${esc(b.opponent.name)}</span>
      <span class="prow-team bg-r2">${crest(m.home)}<b>${esc(m.home.short)}</b></span>
      <span class="prow-team bg-r3">${crest(m.away)}<b>${esc(m.away.short)}</b></span>
      <span class="bg-c1 bg-r2">${mine('home')}</span><span class="bg-c1 bg-r3">${mine('away')}</span>
      ${theirs}
      ${showPts ? `<span class="bg-c1 bg-r4">${pts(it.mine)}</span><span class="bg-c2 bg-r4">${t && !t.hidden ? pts(t) : ''}</span>` : ''}
    </div>
  </div>`;
}

function renderBattle() {
  const sb = state.battle;
  if (!sb) return;
  const { battle: b, matches, edit } = sb;
  const byId = new Map(matches.map((m) => [m.id, m]));
  const [label, cls] = battleLabel(b);
  const me = state.profile ? state.profile.firstName : 'Ты';
  const dirty = b.items.some((it) => {
    const e = edit.get(it.matchId);
    return e && (!it.mine || it.mine.home !== e.home || it.mine.away !== e.away);
  });
  let save = '';
  if (edit.size && (dirty || b.needsMyPicks)) {
    const text = b.status === 'pending' && b.role === 'opponent' ? 'Принять бой' : 'Сохранить счета';
    save = `<button type="button" class="btn btn-primary" data-bact="save">${icon(b.status === 'pending' ? 'i-swords' : 'i-lock')}${text}</button>`;
  }
  let close = '';
  if (b.status === 'pending') close = `<button type="button" class="btn btn-ghost" data-bact="close">${b.role === 'opponent' ? 'Отказаться' : 'Отменить бой'}</button>`;
  const big = b.status === 'done' ? `<span class="bverdict bverdict-${cls}">${label}</span>` : `<span class="bstate bstate-${cls}">${label}</span>`;
  $('battle-body').innerHTML = `
    <div class="glass bhero bhero-${cls}">
      <div class="bhero-vs">
        <span class="bside"><span class="avatar" aria-hidden="true">${esc(initials(me))}</span><b>Ты</b></span>
        <span class="bscore num">${b.score.me}<i>:</i>${b.score.them}</span>
        <span class="bside"><span class="avatar" aria-hidden="true">${esc(initials(b.opponent.name))}</span><b>${esc(b.opponent.name)}</b></span>
      </div>
      ${big}
      <p class="bhero-note">${battleNote(b)}</p>
    </div>
    <p class="hint">${BATTLE_RULE} Счёт друга виден, когда на матч закрывается приём прогнозов.</p>
    <div class="glass list-card">${b.items.map((it) => (byId.has(it.matchId) ? battleItem(it, byId.get(it.matchId), b, edit) : '')).join('')}</div>
    ${save}${close}`;
}

async function battleAction(action) {
  const sb = state.battle;
  if (!sb) return;
  const b = sb.battle;
  if (action === 'save') {
    const picks = [...sb.edit].map(([matchId, p]) => ({ matchId, home: p.home, away: p.away }));
    try {
      const res = await api(`/api/battles/${b.id}/picks`, { method: 'POST', body: { picks } });
      const accepted = b.status === 'pending' && b.role === 'opponent';
      setBattle(res);
      renderBattle();
      haptic('success');
      toast(accepted ? 'Бой принят' : res.skipped ? 'Сохранено. Часть матчей уже закрылась' : 'Счета сохранены');
      loadBattles();
    } catch (err) {
      haptic('error');
      toast(err.message);
      if (err.code === 'locked' || err.code === 'closed') openBattle(b.id);
    }
    return;
  }
  if (action === 'close') {
    const ok = await confirmDialog(b.role === 'opponent' ? `Отказаться от боя с ${b.opponent.name}?` : 'Отменить бой?');
    if (!ok) return;
    try {
      await api(`/api/battles/${b.id}/close`, { method: 'POST' });
      haptic('success');
      toast(b.role === 'opponent' ? 'Ты отказался от боя' : 'Бой отменён');
      state.battle = null;
      go('friends');
    } catch (err) { toast(err.message); }
  }
}

// ---------- Персонаж, которого можно крутить пальцем ----------
// Четыре ракурса без фона: спереди, справа, сзади, слева. Между ними персонаж плавно «доворачивается»:
// сужается к ребру и раскрывается следующим ракурсом. После броска пальцем крутится по инерции.

const VIEWS4 = ['front', 'right', 'back', 'left'];
const DEG_PER_PX = 1.1;
const spin = { angle: 0, els: new Set(), raf: 0, velocity: 0, dragging: false };

function mountSpinners() {
  document.querySelectorAll('[data-spin]').forEach((el) => {
    spin.els.add(el);
    const id = el.dataset.spin || 'tochnyak';
    if (el.dataset.ready === id) return;
    el.dataset.ready = id;
    el.innerHTML = '<div class="spin-imgs">'
      + VIEWS4.map((v) => `<img src="/chars/${encodeURIComponent(id)}/${v}.webp" alt="" draggable="false" decoding="async">`).join('')
      + '</div><span class="spin-floor" aria-hidden="true"></span>';
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    let lastX = 0; let lastT = 0;
    // iOS: не даём странице и Telegram уехать, пока палец крутит персонажа.
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('pointerdown', (e) => {
      spin.dragging = true; spin.velocity = 0;
      cancelAnimationFrame(spin.raf);
      lastX = e.clientX; lastT = performance.now();
      el.setPointerCapture(e.pointerId);
      el.classList.add('grab');
    });
    el.addEventListener('pointermove', (e) => {
      if (!spin.dragging) return;
      e.preventDefault();
      const now = performance.now();
      const d = (e.clientX - lastX) * DEG_PER_PX;
      spin.velocity = spin.velocity * 0.6 + (d / Math.max(1, now - lastT)) * 0.4;
      lastX = e.clientX; lastT = now;
      setAngle(spin.angle + d);
    });
    const end = () => {
      if (!spin.dragging) return;
      spin.dragging = false;
      el.classList.remove('grab');
      if (performance.now() - lastT > 80) spin.velocity = 0;
      coast();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  paintSpin();
}

function setAngle(a) {
  const before = Math.round(spin.angle / 90);
  spin.angle = a;
  if (Math.round(a / 90) !== before) haptic('select');
  paintSpin();
}

// Инерция с трением, в конце мягко встаём на ближайший ракурс.
function coast() {
  let prev = performance.now();
  const step = (now) => {
    const dt = Math.min(40, now - prev); prev = now;
    if (Math.abs(spin.velocity) > 0.03) {
      setAngle(spin.angle + spin.velocity * dt);
      spin.velocity *= Math.pow(0.993, dt);
      spin.raf = requestAnimationFrame(step);
      return;
    }
    const target = Math.round(spin.angle / 90) * 90;
    const diff = target - spin.angle;
    if (Math.abs(diff) < 0.3) { spin.angle = target; paintSpin(); return; }
    spin.angle += diff * Math.min(1, dt * 0.014);
    paintSpin();
    spin.raf = requestAnimationFrame(step);
  };
  spin.raf = requestAnimationFrame(step);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function paintSpin() {
  const pos = ((spin.angle / 90) % 4 + 4) % 4;
  const i = Math.floor(pos);
  const j = (i + 1) % 4;
  const p = pos - i;
  // Ширина: полная на ракурсе, вдвое уже на середине поворота (человек в профиль тоже уже).
  const sx = 0.55 + 0.45 * Math.abs(Math.cos(Math.PI * p));
  const oi = clamp01((0.58 - p) / 0.16);
  const oj = clamp01((p - 0.42) / 0.16);
  for (const el of spin.els) {
    if (!el.isConnected) { spin.els.delete(el); continue; }
    el.querySelectorAll('.spin-imgs img').forEach((img, k) => {
      const o = k === i ? oi : k === j ? oj : 0;
      img.style.opacity = String(o);
      img.style.transform = o ? `scaleX(${sx.toFixed(3)})` : '';
    });
  }
}

boot();
