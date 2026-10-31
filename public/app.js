// Точняк: клиент мини-аппа. Без сборки и зависимостей, только Telegram WebApp SDK.

import { LEGAL } from './legal.js';

const tg = window.Telegram && window.Telegram.WebApp;
const initData = tg ? tg.initData : '';
const isPhone = () => (tg ? ['ios', 'android', 'android_x'].includes(tg.platform) : matchMedia('(pointer: coarse)').matches);

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
  shopSkin: null,
  shopChar: null,
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

// Прогноз на исход хранится как 1:0 / 0:0 / 0:1 с kind = outcome.
const isOutcome = (p) => Boolean(p && p.kind === 'outcome');
const outcomeKey = (p) => (p.home > p.away ? 'home' : p.home < p.away ? 'away' : 'draw');
const OUT_LABEL = { home: 'П1', draw: 'Х', away: 'П2' };
const predText = (p) => (isOutcome(p) ? OUT_LABEL[outcomeKey(p)] : `${p.home}:${p.away}`);
const isExact = (p, m) => Boolean(p && !isOutcome(p) && m.score && p.home === m.score.home && p.away === m.score.away);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (String(name || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2) || '?').toUpperCase();
// Аватарка из Telegram, а пока грузится или если её нет — буквы имени.
const ava = (name, photo, cls = '') => `<span class="avatar ${cls}" aria-hidden="true">${esc(initials(name))}${photo
  ? `<img src="${esc(photo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
const retryBtn = (view) => `<button type="button" class="btn btn-glass btn-inline" data-go="${view}">Обновить</button>`;
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
    // Регистрацию обновили, пока приложение было открыто: показываем её заново.
    if (data.error === 'reg_update' && path !== '/api/me') setTimeout(boot, 0);
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
  if (!img || img.tagName !== 'IMG' || !img.parentElement) return;
  if (img.parentElement.classList.contains('avatar')) { img.remove(); return; }
  if (!img.parentElement.classList.contains('crest')) return;
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
    // На телефоне всегда полный экран. На компьютере — как игрок выбрал кнопкой в шапке.
    let wantFull = true;
    if (!isPhone()) { try { wantFull = localStorage.getItem('tochnyak_fullscreen') !== '0'; } catch { /* по умолчанию полный экран */ } }
    if (wantFull && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen && !tg.isFullscreen) tg.requestFullscreen();
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

// Кто пригласил: код f_xxxxxxxx или ник из ссылки t.me/tochnyak_bot?startapp=<ник>.
function readRef() {
  const fromUrl = new URLSearchParams(location.search).get('f');
  const start = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : '';
  const ref = fromUrl || start || '';
  return /^(f_[a-z0-9]{8}|[a-z0-9]{8}|[A-Za-z][A-Za-z0-9_]{3,31})$/.test(ref) ? ref : null;
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
      $('gate-lead').textContent = me.returning
        ? 'Мы обновили регистрацию. Подтверди правила и привяжи номер, чтобы друзья могли тебя найти. Аура и прогнозы останутся.'
        : 'Угадай счёт. Копи ауру. Обгоняй друзей.';
      $('login-name').textContent = me.firstName || 'Игрок';
      $('login-avatar').outerHTML = ava(me.firstName, me.photo).replace('<span class="avatar ', '<span id="login-avatar" class="avatar ');
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
  const match = /^#match-(\d{1,12})$/.exec(location.hash);
  if (match) state.openMatchId = Number(match[1]);
  if (battle) openBattle(battle[1]);
  else go({ '#profile': 'profile', '#friends': 'friends', '#rating': 'rating' }[location.hash] || 'matches');
  openLegalFromHash();
  clearHash();
  if (state.pendingRef) acceptInvite(state.pendingRef);
  syncFsButton();
  loadBattles().then(() => { if (!battle && !match) showIncomingBattle(); });
}

// Вернулся в приложение из другого чата — проверяем новые вызовы и уведомления.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !state.profile || $('app').hidden) return;
  try {
    const me = await api('/api/me');
    if (me.registered) { state.profile = me.profile; renderTop(); }
  } catch { /* не страшно */ }
  await loadBattles();
  showIncomingBattle();
});

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
  // Аватарку перерисовываем, только если она поменялась, иначе картинка мигает.
  const key = `${p.firstName}|${p.photo || ''}`;
  if (state.topAva !== key) {
    state.topAva = key;
    $('top-avatar').outerHTML = ava(p.firstName, p.photo, 'avatar-sm').replace('<span class="avatar ', '<span id="top-avatar" class="avatar ');
  }
  setBadge(p.unread || 0);
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
  const dpick = t.closest('[data-dpick]');
  if (dpick) { draftPick(dpick.dataset.dpick); return; }
  const och = t.closest('[data-och]');
  if (och) { chooseOut(och.dataset.och); return; }
  const bmode = t.closest('[data-bmode]');
  if (bmode) { setDraftMode(bmode.dataset.bmode); return; }
  const st = t.closest('[data-st]');
  if (st) { stepPick(st.dataset.st); return; }
  const draft = t.closest('[data-draft]');
  if (draft) { toggleDraft(Number(draft.dataset.draft)); return; }
  const challenge = t.closest('[data-challenge]');
  if (challenge) { newBattle(challenge.dataset.challenge, challenge.dataset.name); return; }
  const todayBattle = t.closest('[data-today-battle]');
  if (todayBattle) { newBattle(todayBattle.dataset.todayBattle, todayBattle.dataset.name, true); return; }
  const battleEl = t.closest('[data-battle]');
  if (battleEl) { haptic('light'); openBattle(battleEl.dataset.battle); return; }
  const bact = t.closest('[data-bact]');
  if (bact) { battleAction(bact.dataset.bact); return; }
  const goEl = t.closest('[data-go]');
  if (goEl) { haptic('light'); go(goEl.dataset.go); return; }
  const chip = t.closest('[data-league]');
  if (chip) {
    state.league = chip.dataset.league; haptic('select');
    if (!$('sheet').hidden) closeSheet();
    renderMatches(); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
  }
  const period = t.closest('[data-period]');
  if (period) { state.period = period.dataset.period; setSelected('period', state.period); haptic('select'); loadRating(); return; }
  const fperiod = t.closest('[data-fperiod]');
  if (fperiod) { state.fperiod = fperiod.dataset.fperiod; setSelected('fperiod', state.fperiod); haptic('select'); loadFriends(); return; }
  const mytab = t.closest('[data-mytab]');
  if (mytab) { state.mytab = mytab.dataset.mytab; setSelected('mytab', state.mytab); haptic('select'); renderMy(); return; }
  const pick = t.closest('[data-pick]');
  if (pick) { pickShopCharacter(pick.dataset.pick); return; }
  const skinEl = t.closest('[data-skin]');
  if (skinEl) { pickShopSkin(skinEl.dataset.skin); haptic('select'); renderShop(); return; }
  const shopChar = t.closest('[data-shop-char]');
  if (shopChar) { const ch = state.shop.characters.find((x) => x.id === shopChar.dataset.shopChar); if (ch) { pickShopSkin(ch.skins[0].id); haptic('select'); renderShop(); } return; }
  const shopAct = t.closest('[data-shop]');
  if (shopAct) { shopAction(shopAct.dataset.shop, shopAct.dataset.id); return; }
  const unfriend = t.closest('[data-unfriend]');
  if (unfriend) { removeFriend(unfriend.dataset.unfriend, unfriend.dataset.name); return; }
  const pl = t.closest('[data-player]');
  if (pl) {
    const row = (state.ratingCache && state.ratingCache[state.period] && state.ratingCache[state.period].rows || []).find((x) => x.pub === pl.dataset.player);
    if (row && row.isMe) go('profile'); else openPlayer(pl.dataset.player, row || { name: pl.dataset.pname });
    return;
  }
  const fopen = t.closest('[data-friend-open]');
  if (fopen) { openFriend(fopen.dataset.friendOpen); return; }
  const qp = t.closest('[data-qp]');
  if (qp) { quickPick(Number(qp.dataset.id), qp.dataset.qp, qp); return; }
  const row = t.closest('[data-match]');
  if (row) {
    const id = Number(row.dataset.match);
    const m = state.matches.find((x) => x.id === id) || state.my.find((x) => x.id === id);
    if (m) openSheet(m, row.dataset.mode);
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
    const same = state.matches.length && JSON.stringify(state.matches) === JSON.stringify(data.matches);
    state.matches = data.matches;
    if (!same || !$('match-list').firstChild) renderMatches();
  } catch (err) {
    $('match-list').innerHTML = `<div class="glass empty"><b>Матчи не загрузились</b>${esc(err.message)}${retryBtn('matches')}</div>`;
  }
}

function renderMatches() {
  // Сыгранные матчи тут не нужны: итоги лежат во вкладке «Мои → Сыграны».
  const all = state.matches.filter((m) => !ENDED.includes(m.status));
  const present = LEAGUE_ORDER.filter((code) => all.some((m) => m.competition === code));
  if (state.league !== 'ALL' && !present.includes(state.league)) state.league = 'ALL';

  state.presentLeagues = present;
  $('filter-label').textContent = state.league === 'ALL' ? 'Все лиги' : LEAGUES[state.league] || state.league;
  $('filter-btn').classList.toggle('on', state.league !== 'ALL');
  renderBattleBanner();

  const list = state.league === 'ALL' ? all : all.filter((m) => m.competition === state.league);
  renderHero(list);
  if (state.openMatchId) {
    const want = all.find((m) => m.id === state.openMatchId);
    state.openMatchId = null;
    if (want) openSheet(want, 'outcome');
  }

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
  $('match-list').innerHTML = groups.map((g) => `
    <section class="day">
      <h3 class="day-head"><span>${esc(g.label)}</span><span class="day-count">время МСК</span></h3>
      <div class="glass list-card">${g.items.map(matchRow).join('')}</div>
    </section>`).join('');
}

// Фильтр по чемпионату: одна кнопка над списком, выбор в окне.
function openLeagueFilter() {
  const all = state.matches.filter((m) => !ENDED.includes(m.status));
  const count = (code) => all.filter((m) => code === 'ALL' || m.competition === code).length;
  const row = (code, label) => `<button type="button" class="league-opt${state.league === code ? ' on' : ''}" data-league="${code}" aria-pressed="${state.league === code}">
      <span class="league-opt-name">${esc(label)}</span><span class="league-opt-n num">${count(code)}</span>${state.league === code ? icon('i-check') : ''}</button>`;
  openPanel('<span class="league-tag">Чемпионат</span>', `<div class="glass list-card league-list">
      ${[row('ALL', 'Все лиги')].concat((state.presentLeagues || []).map((code) => row(code, LEAGUES[code] || code))).join('')}
    </div>`, { filter: true });
}
$('filter-btn').addEventListener('click', () => { haptic('light'); openLeagueFilter(); });

// На главной: если друг вызвал на бой или пора поставить прогнозы в бою — заметная плашка.
function renderBattleBanner() {
  const need = (state.battles || []).filter((b) => b.needsMyPicks);
  if (!need.length) { $('battle-banner').innerHTML = ''; return; }
  const b = need[0];
  const text = b.status === 'pending' ? `${esc(b.opponent.name)} вызывает тебя на бой` : `Бой с ${esc(b.opponent.name)}: поставь прогнозы`;
  $('battle-banner').innerHTML = `<button type="button" class="glass battle-banner" data-battle="${esc(b.id)}">
    ${ava(b.opponent.name, b.opponent.photo, 'avatar-sm')}
    <span class="battle-banner-main"><b>${text}</b><span>${b.total} ${plural(b.total, ['матч', 'матча', 'матчей'])}${need.length > 1 ? ` · ещё ${need.length - 1} ${plural(need.length - 1, ['бой', 'боя', 'боёв'])} ждут` : ''}</span></span>
    <span class="battle-banner-go">${icon('i-swords')}Открыть</span>
  </button>`;
}

// «Новый бой»: выбираем друга из списка.
async function openBattlePicker() {
  haptic('light');
  let rows = state.friendRows;
  if (!rows) {
    try { const data = await api('/api/friends?period=week'); rows = state.friendRows = data.rows; } catch { rows = []; }
  }
  const friends = (rows || []).filter((r) => !r.isMe);
  openPanel('<span class="league-tag">Новый бой</span>', friends.length ? `
    <p class="share-lead">С кем бьёмся? Потом выберешь матчи и исходы.</p>
    <div class="glass list-card">${friends.map((r) => `<button type="button" class="pick-friend" data-challenge="${esc(r.code)}" data-name="${esc(r.name)}">
        ${ava(r.name, r.photo, 'avatar-sm')}<b>${esc(r.name)}</b><span class="pick-friend-go">${icon('i-swords')}Бой</span></button>`).join('')}</div>
    <button type="button" class="btn btn-glass" data-add-friend>${icon('i-user-plus')}Добавить друга</button>` : `
    <div class="glass empty"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-swords"/></svg><b>Сначала добавь друга</b>Бой идёт между друзьями: найди его по @username или номеру, или позови по ссылке</div>
    <button type="button" class="btn btn-primary" data-add-friend>${icon('i-user-plus')}Добавить друга</button>`, { picker: true });
}
$('battle-cta').addEventListener('click', openBattlePicker);

// Короткие названия лиг для узкой колонки времени.
const LEAGUE_SHORT = { CL: 'ЛЧ', PL: 'АПЛ', PD: 'Ла Лига', SA: 'Серия А', BL1: 'Бундеслига', FL1: 'Лига 1', DED: 'Эредивизи' };

// Награда за точный счёт: 10 за счёт + по 1 за «обе забьют» и тотал, которые при точном счёте угаданы всегда.
// Должно совпадать с src/scoring.js. Редкий исход может дать ещё больше.
const PRIZE = { aura: 12, coins: 5 };
const prizeInline = () => `<span class="prize-a num">+${PRIZE.aura}${icon('i-target')}</span><span class="prize-c num">+${PRIZE.coins}<span class="coin" aria-hidden="true"></span></span>`;

function timeCell(m) {
  if (LIVE.includes(m.status)) return `<span class="mr-time"><b class="live-sub"><i class="dot"></i>LIVE</b><span>${esc(LEAGUE_SHORT[m.competition] || league(m))}</span></span>`;
  if (m.status === 'POSTPONED') return '<span class="mr-time"><b class="muted">—</b><span>перенос</span></span>';
  return `<span class="mr-time"><b class="num">${timeFmt.format(new Date(m.utcDate))}</b><span>${esc(LEAGUE_SHORT[m.competition] || league(m))}</span></span>`;
}

function teamLine(m, side) {
  const score = m.score && (LIVE.includes(m.status) || m.status === 'FINISHED') ? `<b class="mr-score num${LIVE.includes(m.status) ? ' live' : ''}">${m.score[side]}</b>` : '';
  return `<span class="mr-team">${crest(m[side])}<span class="mr-name">${esc(m[side].short)}</span>${score}</span>`;
}

function matchTag(m) {
  const p = m.prediction;
  if (m.status === 'FINISHED' && m.score) {
    if (!p) return '<span class="tag tag-none">—</span>';
    if (p.points == null) return `<span class="tag tag-wait num">${predText(p)}</span>`;
    return `<span class="tag ${p.points > 0 ? 'tag-hit' : 'tag-miss'}"><span class="num">${predText(p)}</span><b>+${p.points}</b></span>`;
  }
  if (m.open) {
    if (p) return `<span class="tag tag-pred num">${predText(p)}</span>`;
    return '<span class="tag tag-open">Прогноз</span>';
  }
  if (m.status === 'POSTPONED') return '<span class="tag tag-none">—</span>';
  return p ? `<span class="tag tag-wait num">${predText(p)}</span>` : '<span class="tag tag-none">—</span>';
}

function matchRow(m) {
  const label = `${m.home.short} — ${m.away.short}, ${league(m)}`;
  return `<button type="button" class="match-row mr" data-match="${m.id}" aria-label="${esc(label)}">
    ${timeCell(m)}
    <span class="mr-teams">${teamLine(m, 'home')}${teamLine(m, 'away')}</span>
    <span class="mr-side">${matchTag(m)}</span>
  </button>`;
}

// ---------- Главная: матч дня и прогноз в одно касание ----------
// Карточка показывает ближайший матч без прогноза. Нажал П1 / Х / П2 — прогноз сохранён, и сразу следующий матч.

let heroTimer = 0;

function countdownText(ms) {
  if (ms <= 0) return 'приём закрыт';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (h >= 24) return `${Math.floor(h / 24)} д ${h % 24} ч`;
  if (h >= 1) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function renderHero(list) {
  clearInterval(heroTimer);
  const open = list.filter((m) => m.open);
  const queue = open.filter((m) => !m.prediction);
  const today = list.filter((m) => dayDiff(m.utcDate) === 0 && !ENDED.includes(m.status));
  const next = queue[0];
  if (!next) {
    const upcoming = open[0];
    $('hero').innerHTML = open.length || today.length ? `
      <div class="glass hero hero-done">
        <span class="hero-done-ic">🔥</span>
        <b>Все прогнозы сделаны</b>
        <span class="muted small">${upcoming ? `Ближайший матч ${esc(whenShort(upcoming.utcDate))}. Пока ждёшь, брось вызов другу` : 'Новые матчи скоро появятся. Пока ждёшь, брось вызов другу'}</span>
        <button type="button" class="btn btn-primary" data-go="friends">${icon('i-swords')}Вызвать друга на бой</button>
      </div>` : '';
    return;
  }
  const opt = (k, top, name) => `<button type="button" class="qp" data-qp="${k}" data-id="${next.id}">
      <b class="num">${top}</b><span>${esc(name)}</span></button>`;
  $('hero').innerHTML = `
    <div class="glass hero hero-quick" data-hero="${next.id}">
      <div class="hero-meta"><span class="league-tag">${esc(league(next))}</span>
        <span class="badge">${icon('i-clock')}<span class="num" id="hero-count">${countdownText(Date.parse(next.lockAt) - Date.now())}</span></span></div>
      <div class="versus">
        <span class="team">${crest(next.home, 'crest-lg')}<span>${esc(next.home.short)}</span></span>
        <span class="hero-time"><span class="num">${timeFmt.format(new Date(next.utcDate))}</span><span class="muted small">${esc(dayLabel(next.utcDate).toLowerCase())}</span></span>
        <span class="team">${crest(next.away, 'crest-lg')}<span>${esc(next.away.short)}</span></span>
      </div>
      <p class="hero-q">Кто победит?</p>
      <div class="qp-grid">${opt('home', 'П1', next.home.short)}${opt('draw', 'Х', 'Ничья')}${opt('away', 'П2', next.away.short)}</div>
      <button type="button" class="link hero-exact" data-match="${next.id}" data-mode="score">Точный счёт →</button>
    </div>`;
  heroTimer = setInterval(() => {
    const el = $('hero-count');
    if (!el || state.view !== 'matches') { clearInterval(heroTimer); return; }
    el.textContent = countdownText(Date.parse(next.lockAt) - Date.now());
  }, 1000);
}

async function quickPick(id, key, btn) {
  const m = state.matches.find((x) => x.id === id);
  if (!m || !m.open) return;
  document.querySelectorAll('.qp').forEach((b) => { b.disabled = true; });
  btn.classList.add('picked');
  haptic('medium');
  try {
    const res = await api('/api/predictions', { method: 'POST', body: { matchId: id, kind: 'outcome', pick: key } });
    m.prediction = { home: res.prediction.home, away: res.prediction.away, kind: 'outcome', points: null };
    haptic('success');
    toast(`${OUT_LABEL[key]} залочено`);
    const card = document.querySelector('.hero-quick');
    if (card) card.classList.add('leaving');
    setTimeout(renderMatches, 260);
  } catch (err) {
    haptic('error');
    toast(err.message);
    if (err.code === 'locked') { m.open = false; loadMatches(); return; }
    document.querySelectorAll('.qp').forEach((b) => { b.disabled = false; });
    btn.classList.remove('picked');
  }
}

// ---------- Окно матча: прогноз или итог ----------

function openSheet(m, mode) {
  const p = m.prediction;
  const out = isOutcome(p);
  // По умолчанию — прогноз на победу, точный счёт второй вкладкой.
  state.sheet = { match: m, mode: mode === 'score' || (p && !out) ? 'score' : 'outcome', home: p && !out ? p.home : 1, away: p && !out ? p.away : 0, pick: out ? outcomeKey(p) : null };
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
  const modes = `<div class="glass segmented" role="tablist" aria-label="Тип прогноза">
      <button type="button" role="tab" data-pmode="outcome" aria-selected="${s.mode === 'outcome'}">Победа</button>
      <button type="button" role="tab" data-pmode="score" aria-selected="${s.mode === 'score'}">Точный счёт</button>
    </div>`;
  if (s.mode === 'outcome') {
    const opt = (key, top, name) => `<button type="button" class="out-btn" data-out="${key}" aria-pressed="${s.pick === key}">
      <b class="num">${top}</b><span>${esc(name)}</span></button>`;
    $('sheet-body').innerHTML = `
      ${teamsHead(m, '<span class="vs-dash" aria-hidden="true">vs</span>')}
      ${modes}
      <div class="out-grid" role="group" aria-label="Исход матча">
        ${opt('home', 'П1', m.home.short)}${opt('draw', 'Х', 'Ничья')}${opt('away', 'П2', m.away.short)}
      </div>
      <button type="button" id="save-btn" class="btn btn-primary"${s.pick ? '' : ' disabled'}>${icon('i-lock')}${s.pick ? `Залочить <span class="num">${OUT_LABEL[s.pick]}</span>` : 'Выбери исход'}</button>
      <p class="hero-prize">За угаданный исход <span class="prize-a num">+2${icon('i-target')}</span><span class="prize-c num">+1<span class="coin" aria-hidden="true"></span></span></p>
      <p class="sheet-foot">Уверен в счёте? Вкладка «Точный счёт» даёт до +12. Приём закроется через <span class="num">${untilText(left)}</span></p>
      <p id="sheet-error" class="error center" role="alert" hidden></p>`;
    return;
  }
  const outcome = s.home > s.away ? `П1 · ${m.home.short}` : s.home < s.away ? `П2 · ${m.away.short}` : 'Ничья';
  const btts = s.home > 0 && s.away > 0 ? 'Обе забьют' : 'Не обе';
  const total = s.home + s.away > 2 ? 'ТБ 2,5' : 'ТМ 2,5';
  $('sheet-body').innerHTML = `
    ${teamsHead(m, '<span class="vs-dash" aria-hidden="true">vs</span>')}
    ${modes}
    <div class="score-grid">
      ${stepper('home', s.home, m.home.short)}
      ${stepper('away', s.away, m.away.short)}
    </div>
    <div class="quick" role="group" aria-label="Быстрый выбор счёта">
      ${QUICK_SCORES.map(([h, a]) => `<button type="button" class="chip chip-num num" data-quick="${h}:${a}" aria-pressed="${s.home === h && s.away === a}">${h}:${a}</button>`).join('')}
    </div>
    <div class="pills">${[outcome, btts, total].map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>
    <button type="button" id="save-btn" class="btn btn-primary">${icon('i-lock')}Залочить <span class="num">${s.home}:${s.away}</span></button>
    <p class="hero-prize">За точный счёт ${prizeInline()}</p>
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
  if (!p) mine = '<div class="mine mine-empty">Прогноза на этот матч нет</div>';
  else {
    const exact = p.points != null && isExact(p, m);
    const pts = p.points == null ? '<span class="muted">ждём финал</span>' : `<b class="num ${p.points > 0 ? 'pts-hit' : ''}">+${p.points}</b>`;
    mine = `<div class="mine${exact ? ' mine-exact' : ''}"><span class="muted small">${isOutcome(p) ? 'Мой исход' : 'Мой прогноз'}</span><span class="num mine-score">${predText(p)}</span>${pts}${exact ? '<span class="stamp">ТОЧНЯК!</span>' : ''}</div>`;
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
  const pmode = e.target.closest('[data-pmode]');
  if (pmode) { s.mode = pmode.dataset.pmode; haptic('select'); renderSheet(); return; }
  const out = e.target.closest('[data-out]');
  if (out) { s.pick = out.dataset.out; haptic('select'); renderSheet(); return; }
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
    const body = s.mode === 'outcome'
      ? { matchId: s.match.id, kind: 'outcome', pick: s.pick }
      : { matchId: s.match.id, home: s.home, away: s.away };
    const res = await api('/api/predictions', { method: 'POST', body });
    s.match.prediction = { home: res.prediction.home, away: res.prediction.away, kind: res.prediction.kind, points: null };
    haptic('success');
    closeSheet();
    if (state.view === 'matches') renderMatches(); else loadMy();
    toast(`Залочено ${predText(s.match.prediction)}`);
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
    $('my-list').innerHTML = `<div class="glass empty"><b>Не загрузилось</b>${esc(err.message)}${retryBtn('my')}</div>`;
  }
}

function isDone(m) { return m.prediction && m.prediction.points != null; }

function renderMy() {
  const done = state.my.filter(isDone);
  const wait = state.my.filter((m) => !isDone(m)).reverse();
  const exact = done.filter((m) => isExact(m.prediction, m)).length;
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
  $('my-list').innerHTML = (state.mytab === 'wait' ? `<p class="tz-note">${icon('i-clock')}Слева твой прогноз и время матча по МСК</p>` : '')
    + `<div class="glass list-card">${items.map(myRow).join('')}</div>`;
}

function myRow(m) {
  const p = m.prediction;
  const exact = isDone(m) && isExact(p, m);
  let right;
  if (isDone(m)) right = `<span class="my-pts ${p.points > 0 ? 'pts-hit' : 'pts-zero'} num">+${p.points}</span>`;
  else if (m.open) right = '<span class="tag tag-open">Изменить</span>';
  else right = `<span class="tag tag-none">${LIVE.includes(m.status) ? 'идёт' : 'ждём'}</span>`;
  const sub = isDone(m) || LIVE.includes(m.status) ? (exact ? 'точняк!' : isOutcome(p) ? 'исход' : 'прогноз') : whenTiny(m.utcDate);
  return `<button type="button" class="match-row mr" data-match="${m.id}" aria-label="${esc(`${m.home.short} — ${m.away.short}`)}">
    <span class="mr-time my-pick${exact ? ' exact' : ''}"><b class="num">${predText(p)}</b><span>${esc(sub)}</span></span>
    <span class="mr-teams">${teamLine(m, 'home')}${teamLine(m, 'away')}</span>
    <span class="mr-side">${right}</span>
  </button>`;
}

// ---------- Друзья ----------

async function loadFriends() {
  const cache = (state.friendsCache = state.friendsCache || {});
  const period = state.fperiod;
  if (cache[period]) renderFriends(cache[period]);
  else $('friends-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api(`/api/friends?period=${period}`);
    const same = cache[period] && JSON.stringify(cache[period]) === JSON.stringify(data);
    cache[period] = data;
    if (!same && state.fperiod === period) renderFriends(data);
  } catch (err) {
    if (!cache[period]) $('friends-list').innerHTML = `<div class="glass empty"><b>Не загрузилось</b>${esc(err.message)}${retryBtn('friends')}</div>`;
  }
}

function renderFriends(data) {
  {
    state.friendLink = data.link || data.shareLink;
    if (data.rows.length <= 1) {
      $('friends-list').innerHTML = `<div class="glass empty friends-empty">
        <svg class="ic ic-xl" aria-hidden="true"><use href="#i-users"/></svg>
        <b>Тут будет ваша лига</b>Найди друга по @username или номеру, или позови по ссылке
        <button type="button" class="btn btn-primary btn-inline" data-add-friend>${icon('i-user-plus')}Добавить друга</button></div>`;
      return;
    }
    state.friendRows = data.rows;
    $('friends-list').innerHTML = `<div class="glass list-card">${data.rows.map((r) => {
      const inner = `<span class="lb-rank num">${r.rank}</span>
        ${ava(r.name, r.photo, 'avatar-sm')}
        <span class="lb-name">${r.isMe ? 'Ты' : esc(r.name)}</span>
        <span class="lb-pts num">${r.pts}${icon('i-target')}</span>`;
      if (r.isMe) return `<div class="lb-row me">${inner}<span class="fight-ic fight-ghost" aria-hidden="true"></span></div>`;
      return `<div class="lb-row lb-tap" data-friend-open="${esc(r.code)}" role="button" tabindex="0" aria-label="${esc(r.name)}">${inner}
        <button type="button" class="fight-ic" data-challenge="${esc(r.code)}" data-name="${esc(r.name)}" aria-label="Бой с ${esc(r.name)}">${icon('i-swords')}</button></div>`;
    }).join('')}</div>`;
  }
}

async function friendLink() {
  if (!state.friendLink) {
    const data = await api('/api/friends');
    state.friendLink = data.link || data.shareLink;
  }
  return state.friendLink;
}

const INVITE_TEXT = 'Приглашаю тебя в Точняк 🎯 Угадываем победителей и счёт футбольных матчей, в конце недели смотрим, кто точнее. Залетай:';

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
      // В полноэкранном режиме iPhone окно отправки Telegram заезжает под часы, и крестик трудно нажать.
      // На время отправки выходим из полного экрана и потом возвращаемся.
      const wasFull = Boolean(tg.isFullscreen && tg.exitFullscreen);
      const restore = () => { if (wasFull) { try { tg.requestFullscreen(); } catch { /* не страшно */ } } };
      if (wasFull) { try { tg.exitFullscreen(); } catch { /* не страшно */ } await new Promise((r) => setTimeout(r, 350)); }
      shareFallback = () => { restore(); shareLink().catch((err) => toast(err.message)); };
      tg.shareMessage(prepared.id, (sent) => {
        shareFallback = null;
        restore();
        if (sent) { haptic('success'); toast('Приглашение отправлено'); }
      });
      return;
    } catch { shareFallback = null; /* ниже обычная ссылка */ }
  }
  await shareLink();
}

// ---------- Окно «Позвать друга»: Telegram, WhatsApp, Instagram, VK, системное «Поделиться» ----------

const SHARE_APPS = [
  { id: 'wa', name: 'WhatsApp', color: '#25D366', glyph: '<path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z"/><path d="M9 8.5c.3 2.6 2.4 5.2 5.4 6l1.1-1.3-1.8-1-.9.8c-1-.4-1.9-1.3-2.4-2.4l.8-.9-1-1.8z" fill="currentColor" stroke="none"/>' },
  { id: 'ig', name: 'Instagram', color: 'linear-gradient(45deg,#f9a825,#e91e63 50%,#7b1fa2)', glyph: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17" cy="7" r=".9" fill="currentColor"/>' },
  { id: 'vk', name: 'VK', color: '#0077FF', glyph: '<path d="M4 7.5h2.6c.3 3.3 1.8 5 3 5.3V7.5h2.4v2.9c1.2-.1 2.4-1.5 2.9-2.9h2.4c-.4 1.9-1.8 3.3-2.8 3.9 1 .5 2.6 1.7 3.2 4h-2.6c-.5-1.5-1.7-2.7-3.1-2.8v2.8h-.3C7.1 15.4 4.2 12.6 4 7.5z" fill="currentColor" stroke="none"/>' },
  { id: 'more', name: 'Ещё', color: 'rgba(255,255,255,.12)', glyph: '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>' }
];

const prettyLink = (link) => String(link || '').replace(/^https?:\/\//, '');

// Картинка-приглашение для сторис 1080×1920: рисуем прямо в приложении.
function loadImg(src) {
  return new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

async function makeStoryImage(link) {
  const W = 1080; const H = 1920;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  try { await Promise.all([document.fonts.load('800 100px Unbounded'), document.fonts.load('700 40px Manrope')]); } catch { /* системный шрифт тоже ок */ }
  const disp = "'Unbounded', 'Arial Black', sans-serif";
  const body = "'Manrope', -apple-system, 'Segoe UI', sans-serif";
  ctx.fillStyle = '#02060E'; ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, 1100);
  g.addColorStop(0, 'rgba(197,3,55,0.95)'); g.addColorStop(0.45, 'rgba(197,3,55,0.3)'); g.addColorStop(1, 'rgba(2,6,14,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W / 2, 1150, 0, W / 2, 1150, 520);
  g.addColorStop(0, 'rgba(197,3,55,0.55)'); g.addColorStop(1, 'rgba(197,3,55,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 500, W, 1200);
  // Логотип-мишень и название
  ctx.strokeStyle = '#FF2E63'; ctx.lineWidth = 9;
  [46, 24].forEach((r) => { ctx.beginPath(); ctx.arc(W / 2, 200, r, 0, Math.PI * 2); ctx.stroke(); });
  ctx.fillStyle = '#F5F2F4'; ctx.beginPath(); ctx.arc(W / 2, 200, 9, 0, Math.PI * 2); ctx.fill();
  ctx.textAlign = 'center'; ctx.fillStyle = '#F5F2F4';
  ctx.font = `800 64px ${disp}`; ctx.fillText('ТОЧНЯК', W / 2, 320);
  ctx.font = `800 88px ${disp}`; ctx.fillText('Приглашаю', W / 2, 500); ctx.fillText('тебя в Точняк', W / 2, 610);
  ctx.fillStyle = 'rgba(245,242,244,0.72)'; ctx.font = `700 42px ${body}`;
  ctx.fillText('Угадай победителя и счёт матчей.', W / 2, 700); ctx.fillText('Посмотрим, кто из нас точнее', W / 2, 756);
  // Персонаж
  const ch = await loadImg(`/chars/${encodeURIComponent((state.profile && state.profile.character) || 'tochnyak')}/front.webp`);
  if (ch) { const h = 820; const w = (ch.width / ch.height) * h; ctx.drawImage(ch, (W - w) / 2, 800, w, h); }
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.ellipse(W / 2, 1625, 210, 26, 0, 0, Math.PI * 2); ctx.fill();
  // Ссылка внизу
  roundRect(ctx, 90, 1680, W - 180, 150, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#ff8fab'; ctx.font = `700 30px ${body}`; ctx.fillText('Играть в Telegram', W / 2, 1738);
  ctx.fillStyle = '#F5F2F4'; ctx.font = `800 40px ${body}`; ctx.fillText(prettyLink(link), W / 2, 1796);
  return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
}

// Итог боя для сторис и постов: счёт, вердикт и ссылка на приложение.
async function makeBattleImage(b, link) {
  const W = 1080; const H = 1920;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  try { await Promise.all([document.fonts.load('800 100px Unbounded'), document.fonts.load('700 40px Manrope')]); } catch { /* системный шрифт тоже ок */ }
  const disp = "'Unbounded', 'Arial Black', sans-serif";
  const body = "'Manrope', -apple-system, 'Segoe UI', sans-serif";
  ctx.fillStyle = '#02060E'; ctx.fillRect(0, 0, W, H);
  let g = ctx.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, 1100);
  g.addColorStop(0, 'rgba(197,3,55,0.95)'); g.addColorStop(0.45, 'rgba(197,3,55,0.3)'); g.addColorStop(1, 'rgba(2,6,14,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#F5F2F4'; ctx.font = `800 64px ${disp}`; ctx.fillText('ТОЧНЯК', W / 2, 200);
  ctx.fillStyle = 'rgba(245,242,244,0.7)'; ctx.font = `700 40px ${body}`;
  ctx.fillText(b.mode === 'outcome' ? 'Бой на победу' : 'Бой на точный счёт', W / 2, 268);
  const verdict = b.result === 'win' ? 'Я точнее!'
    : b.result === 'lose' ? `${b.opponent.name.slice(0, 14)} точнее`
      : b.status === 'done' ? 'Ничья' : 'Бой идёт';
  ctx.fillStyle = '#FF2E63'; ctx.font = `800 84px ${disp}`; ctx.fillText(verdict, W / 2, 480);
  ctx.fillStyle = '#F5F2F4'; ctx.font = `800 240px ${disp}`; ctx.fillText(`${b.score.me} : ${b.score.them}`, W / 2, 800);
  ctx.font = `700 46px ${body}`; ctx.fillStyle = 'rgba(245,242,244,0.85)';
  ctx.fillText('Ты', W * 0.27, 900); ctx.fillText(b.opponent.name.slice(0, 16), W * 0.73, 900);
  ctx.font = `700 40px ${body}`; ctx.fillStyle = 'rgba(245,242,244,0.6)';
  ctx.fillText(`Сыграно ${b.decided} из ${b.total} ${plural(b.total, ['матча', 'матчей', 'матчей'])}`, W / 2, 980);
  const ch = await loadImg(`/chars/${encodeURIComponent((state.profile && state.profile.character) || 'tochnyak')}/front.webp`);
  if (ch) { const h = 600; const w = (ch.width / ch.height) * h; ctx.drawImage(ch, (W - w) / 2, 1040, w, h); }
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.ellipse(W / 2, 1645, 200, 24, 0, 0, Math.PI * 2); ctx.fill();
  roundRect(ctx, 90, 1700, W - 180, 130, 44);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#ff8fab'; ctx.font = `700 30px ${body}`; ctx.fillText('Сыграй со мной', W / 2, 1752);
  ctx.fillStyle = '#F5F2F4'; ctx.font = `800 36px ${body}`; ctx.fillText(prettyLink(link) || 't.me/tochnyak_bot', W / 2, 1806);
  return new Promise((resolve) => cv.toBlob((x) => resolve(x), 'image/png'));
}

async function openBattleShare() {
  const sb = state.battle;
  if (!sb) return;
  haptic('light');
  const b = sb.battle;
  let link = '';
  try { link = await friendLink(); } catch { /* картинка без ссылки */ }
  const blob = await makeBattleImage(b, link);
  if (!blob) { toast('Картинка не готова'); return; }
  state.battleBlob = blob;
  const url = URL.createObjectURL(blob);
  const text = `Бой с ${b.opponent.name}: ${b.score.me}:${b.score.them}. Угадываем счёт в Точняке ${link}`.trim();
  openPanel('<span class="league-tag">Итог боя</span>', `
    <img class="story-prev" src="${url}" alt="Итог боя с картинкой">
    <button type="button" class="btn btn-primary" data-battle-share="native">${icon('i-share')}Поделиться картинкой</button>
    <div class="btn-pair">
      <a class="btn btn-glass" href="${url}" download="tochnyak-battle.png">${icon('i-copy')}Сохранить</a>
      <button type="button" class="btn btn-glass" data-battle-share="threads">Threads</button>
    </div>
    <p class="sheet-foot">Выложи картинку в сторис Instagram или в пост Threads. Для Threads текст уже скопирован.</p>`, { battleShare: true, text });
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-battle-share]');
  if (!btn) return;
  const s = state.sheet || {};
  haptic('light');
  if (btn.dataset.battleShare === 'native') {
    const file = new File([state.battleBlob], 'tochnyak-battle.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: s.text }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    toast('Сохрани картинку и выложи в Instagram или Threads');
    return;
  }
  if (btn.dataset.battleShare === 'threads') {
    if (await copyText(s.text)) toast('Текст скопирован. Вставь его в Threads вместе с картинкой');
    openExternal(`https://www.threads.net/intent/post?text=${encodeURIComponent(s.text || '')}`);
  }
});

async function openInviteSheet() {
  haptic('light');
  let link = '';
  try { link = await friendLink(); } catch (err) { toast(err.message); return; }
  // Картинку для сторис готовим заранее: iPhone разрешает «Поделиться» только сразу после нажатия.
  state.story = makeStoryImage(link).then((blob) => { state.storyBlob = blob; return blob; }).catch(() => null);
  openPanel('<span class="league-tag">Позвать друга</span>', `
    <p class="share-lead">Друг перейдёт по ссылке, войдёт через Telegram и сразу появится у тебя в друзьях.</p>
    <button type="button" class="btn btn-primary btn-tg" data-share="tg"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4.5L2.8 11.4c-.9.4-.9 1.5 0 1.8l4.4 1.5 1.7 5.3c.2.6 1 .8 1.5.3l2.5-2.3 4.5 3.3c.6.4 1.4.1 1.6-.6L22.2 5.7c.2-.9-.6-1.5-1.2-1.2zM9.5 14.2l8.2-6.6-6.6 7.6-.3 3.1z" fill="currentColor" stroke="none"/></svg>Отправить в Telegram</button>
    <div class="share-grid">${SHARE_APPS.map((a) => `
      <button type="button" class="share-app" data-share="${a.id}">
        <span class="share-ic" style="background:${a.color}"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${a.glyph}</svg></span>
        <span>${a.name}</span>
      </button>`).join('')}</div>
    <div class="share-link">
      <span class="share-url">${esc(prettyLink(link))}</span>
      <button type="button" class="btn btn-glass btn-square" id="sheet-copy" aria-label="Скопировать ссылку">${icon('i-copy')}</button>
    </div>`, { shareSheet: true });
}

$('invite-btn').addEventListener('click', openInviteSheet);

function openExternal(url) {
  try { if (tg && tg.openLink) { tg.openLink(url); return; } } catch { /* ниже запасной вариант */ }
  window.open(url, '_blank');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* ниже запасной вариант */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-open-ig]')) openExternal('https://www.instagram.com/'); });

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-share]');
  if (!btn) return;
  const kind = btn.dataset.share;
  haptic('light');
  try {
    const link = await friendLink();
    const message = `${INVITE_TEXT} ${link}`;
    if (kind === 'tg') { closeSheet(); await shareInvite(); return; }
    if (kind === 'wa') { openExternal(`https://wa.me/?text=${encodeURIComponent(message)}`); return; }
    if (kind === 'vk') { openExternal(`https://vk.com/share.php?url=${encodeURIComponent(link)}&title=${encodeURIComponent(INVITE_TEXT)}`); return; }
    if (kind === 'ig') {
      // Instagram принимает картинку через системное «Поделиться»: сторис или Директ.
      // Ссылку копируем, чтобы добавить её стикером «Ссылка».
      const blob = state.storyBlob || (await state.story);
      await copyText(link);
      if (blob) {
        const file = new File([blob], 'tochnyak-invite.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file] });
            toast('Ссылка скопирована: добавь в сторис стикер «Ссылка»');
            return;
          } catch (err) { if (err && err.name === 'AbortError') return; }
        }
        // Telegram не дал открыть «Поделиться» — показываем картинку, её можно сохранить.
        const url = URL.createObjectURL(blob);
        openPanel('<span class="league-tag">Сторис для Instagram</span>', `
          <img class="story-prev" src="${url}" alt="Картинка-приглашение для сторис">
          <ol class="story-steps">
            <li>Зажми картинку и выбери «Сохранить в Фото».</li>
            <li>В Instagram выложи её в сторис.</li>
            <li>Добавь стикер «Ссылка» — ссылка уже скопирована.</li>
          </ol>
          <button type="button" class="btn btn-primary" data-open-ig>Открыть Instagram</button>`, { story: true });
        return;
      }
      toast('Ссылка скопирована, вставь её в Instagram');
      openExternal('https://www.instagram.com/');
      return;
    }
    if (kind === 'more') {
      if (navigator.share) {
        try { await navigator.share({ text: INVITE_TEXT, url: link }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
      }
      if (await copyText(message)) toast('Скопировано, вставь в любой мессенджер');
      else toast('Не получилось скопировать');
    }
  } catch (err) { toast(err.message); }
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
    <div class="btn-pair">
      <button type="button" class="btn btn-glass" id="sheet-invite">${icon('i-share')}Позвать</button>
      <button type="button" class="btn btn-glass" id="sheet-copy">${icon('i-copy')}Ссылка</button>
    </div>`, { addFriend: true });
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
  if (e.target.closest('#sheet-invite')) { openInviteSheet(); return; }
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

async function copyInvite() {
  try {
    const link = await friendLink();
    if (await copyText(link)) { haptic('success'); toast('Ссылка скопирована'); } else toast('Не получилось скопировать');
  } catch { toast('Не получилось скопировать'); }
}
document.addEventListener('click', (e) => { if (e.target.closest('#sheet-copy')) copyInvite(); });

$('copy-btn') && $('copy-btn').addEventListener('click', async () => {
  try {
    const link = await friendLink();
    await navigator.clipboard.writeText(link);
    haptic('success');
    toast('Ссылка скопирована');
  } catch { toast('Не получилось скопировать'); }
});

// Карточка друга: бой или убрать из друзей.
function openFriend(code) {
  const r = (state.friendRows || []).find((x) => x.code === code);
  if (r) openPlayer(r.pub, r);
}

// Профиль другого игрока: персонаж (можно крутить), аура и статистика. Для друга — кнопки боя.
async function openPlayer(pub, hint = {}) {
  if (!pub) return;
  haptic('light');
  const head = (name, photo) => `<div class="player-head">${ava(name, photo, 'avatar-sm')}<b>${esc(name || 'Игрок')}</b></div>`;
  openPanel('<span class="league-tag">Профиль игрока</span>', `${head(hint.name, hint.photo)}
    <div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>`, { player: pub });
  let p;
  try { p = await api(`/api/player/${encodeURIComponent(pub)}`); } catch (err) {
    if (state.sheet && state.sheet.player === pub) $('sheet-body').innerHTML = `<div class="glass empty"><b>Профиль не открылся</b>${esc(err.message)}</div>`;
    return;
  }
  if (!state.sheet || state.sheet.player !== pub) return;
  if (p.isMe) { closeSheet(); go('profile'); return; }
  const since = p.joinedAt ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date(p.joinedAt)) : '';
  const fc = p.friendCode;
  $('sheet-body').innerHTML = `
    <div class="player-card">
      <div class="hero-dude player-dude">
        <span class="dude-glow" aria-hidden="true"></span>
        <div class="spin" data-spin="${esc(p.character)}" role="img" aria-label="Персонаж игрока ${esc(p.name)}: крути пальцем"></div>
      </div>
      <div class="profile-name">${head(p.name, p.photo)}
        <span class="stat-chip player-aura"><svg class="ic ic-aura" aria-hidden="true"><use href="#i-target"/></svg><span class="num">${p.aura}</span></span></div>
      <div class="strip strip-flat">
        <span><b class="num">${p.weekRank || '—'}</b><span>место за неделю</span></span>
        <span><b class="num">${p.hits || 0}<small> из ${p.settledPredictions || 0}</small></b><span>матчей угадано</span></span>
        <span><b class="num">${p.exactHits}</b><span>${plural(p.exactHits, ['точный счёт', 'точных счёта', 'точных счетов'])}</span></span>
      </div>
      ${since ? `<span class="player-since">В Точняке с ${esc(since.replace(' г.', ''))}</span>` : ''}
    </div>
    ${fc ? `<button type="button" class="btn btn-primary" data-challenge="${esc(fc)}" data-name="${esc(p.name)}">${icon('i-swords')}Вызвать на бой</button>
    <button type="button" class="btn btn-glass" data-today-battle="${esc(fc)}" data-name="${esc(p.name)}">${icon('i-swords')}Бой на сегодняшние матчи</button>
    <button type="button" class="btn btn-ghost" data-unfriend="${esc(fc)}" data-name="${esc(p.name)}">Убрать из друзей</button>`
    : '<p class="sheet-foot">Чтобы вызвать на бой, добавьте друг друга в друзья.</p>'}`;
  mountSpinners();
}

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
  const cache = (state.ratingCache = state.ratingCache || {});
  const period = state.period;
  if (cache[period]) renderRating(cache[period]);
  else $('rating-list').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    const data = await api(`/api/leaderboard?period=${period}`);
    const same = cache[period] && JSON.stringify(cache[period]) === JSON.stringify(data);
    cache[period] = data;
    if (!same && state.period === period) renderRating(data);
  } catch (err) {
    if (!cache[period]) $('rating-list').innerHTML = `<div class="glass empty"><b>Рейтинг не загрузился</b>${esc(err.message)}${retryBtn('rating')}</div>`;
  }
}

function renderRating(data) {
  {
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
      <div class="lb-row lb-tap${r.isMe ? ' me' : ''}" data-player="${esc(r.pub || '')}" data-pname="${esc(r.name)}" role="button" tabindex="0" aria-label="Профиль: ${esc(r.isMe ? 'ты' : r.name)}">
        <span class="lb-rank num">${r.rank}</span>
        ${ava(r.name, r.photo, 'avatar-sm')}
        <span class="lb-name">${r.isMe ? 'Ты' : esc(r.name)}</span>
        <span class="lb-pts num">${r.pts}</span>
      </div>`).join('')}</div>`;
  }
}

// ---------- Профиль ----------

async function loadProfile() {
  renderProfile();
  try {
    const me = await api('/api/me');
    if (me.registered) { state.profile = me.profile; renderTop(); renderProfile(); }
  } catch { /* покажем то, что уже есть */ }
}

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  $('friends-count').textContent = p.friendsCount ? p.friendsCount : '';
  const html = `<div class="glass profile-card">
    <div class="hero-dude">
      <span class="dude-glow" aria-hidden="true"></span>
      <div class="spin" data-spin="${esc(p.character || 'tochnyak')}" role="img" aria-label="Твой персонаж: крути пальцем влево и вправо"></div>
      <button type="button" class="dude-btn" data-go="shop">${icon('i-bag')}Магазин</button>
    </div>
    <div class="profile-name"><b>${esc(p.firstName || 'Игрок')}</b>
      <button type="button" class="profile-wallet" data-econ aria-label="Что такое монеты и аура"><span class="stat-chip"><span class="coin" aria-hidden="true"></span><span class="num">${p.coins || 0}</span></span>
      <span class="stat-chip"><svg class="ic ic-aura" aria-hidden="true"><use href="#i-target"/></svg><span class="num">${p.aura}</span></span><svg class="ic ic-info" aria-hidden="true"><use href="#i-info"/></svg></button></div>
    <div class="strip strip-flat">
      <span><b class="num">${p.weekRank || '—'}</b><span>место за неделю</span></span>
      <span><b class="num">${p.hits || 0}<small> из ${p.settledPredictions || 0}</small></b><span>матчей угадано</span></span>
      <span><b class="num">${p.exactHits}</b><span>${plural(p.exactHits, ['точный счёт', 'точных счёта', 'точных счетов'])}</span></span>
    </div>
  </div>`;
  if (html === state.profileHtml && $('profile-card').firstChild) return;
  state.profileHtml = html;
  $('profile-card').innerHTML = html;
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
  ['Исход в прогнозе на счёт', '+3', '+2'],
  ['«Только победа» угадана', '+2', '+1'],
  ['Обе забьют / нет', '+1', ''],
  ['Тотал 2,5', '+1', ''],
  ['Редкий исход', '×1,5–×2', ''],
  ['Друг по твоей ссылке', '', '+10'],
  ['Первое место недели', '', '+10']
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
        <p>Валюта для магазина: на монеты покупаешь персонажей и их образы. На рейтинг не влияют.</p>
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
      <button type="button" role="tab" data-legal="privacy" aria-selected="${key === 'privacy'}">Данные</button>
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
  const ok = await confirmDialog('Удалить аккаунт? Аура, монеты, персонажи, прогнозы, друзья и бои сотрутся навсегда.');
  if (!ok) return;
  try {
    await api('/api/me', { method: 'DELETE' });
    haptic('success');
    state.profile = null;
    state.matches = [];
    state.my = [];
    state.battles = [];
    state.friendsCache = {};
    state.ratingCache = {};
    state.profileHtml = null;
    state.topAva = null;
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
// Персонаж покупается вместе с первым образом, остальные образы — после него.
// Смотреть и крутить можно любой образ; если монет не хватает, он под замком.

const skinFrames = (id) => (String(id || '').includes('_') ? 12 : 4);
const TIER_CLASS = ['', 't1', 't2', 't3', 't4'];

async function loadShop() {
  if (!state.shop) $('shop-grid').innerHTML = '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>';
  try {
    state.shop = await api('/api/shop');
    const skin = shopSkin(state.shopSkin);
    if (!skin) pickShopSkin(state.shop.selected);
    renderShop();
  } catch (err) {
    $('shop-grid').innerHTML = `<div class="glass empty"><b>Магазин не загрузился</b>${esc(err.message)}${retryBtn('shop')}</div>`;
  }
}

function shopSkin(id) {
  if (!state.shop || !id) return null;
  for (const c of state.shop.characters) {
    const s = c.skins.find((x) => x.id === id);
    if (s) return { c, s };
  }
  return null;
}

function pickShopSkin(id) {
  const found = shopSkin(id) || shopSkin(state.shop.selected) || { c: state.shop.characters[0], s: state.shop.characters[0].skins[0] };
  state.shopSkin = found.s.id;
  state.shopChar = found.c.id;
}

// Карточка персонажа показывает надетый образ, иначе первый.
function charCover(c) {
  return (c.skins.find((s) => s.selected) || c.skins[0]);
}

function shopButton(c, s, coins) {
  const coin = (n) => `<span class="coin" aria-hidden="true"></span><span class="num">${n}</span>`;
  if (s.selected) return `<button type="button" class="btn btn-glass" disabled>${icon('i-check')}Надет</button>`;
  if (s.owned) return `<button type="button" class="btn btn-primary" data-shop="select" data-id="${esc(s.id)}">Надеть</button>`;
  if (s.needsCharacter) {
    return `<button type="button" class="btn btn-glass btn-locked" data-shop-char="${esc(c.id)}">${icon('i-lock')}Сначала персонаж за ${coin(c.price)}</button>`;
  }
  const what = s.tier === 1 ? 'персонажа' : 'образ';
  if (coins < s.price) {
    return `<button type="button" class="btn btn-glass btn-locked" disabled>${icon('i-lock')}${coin(s.price)}<span class="btn-sub">не хватает ${s.price - coins}</span></button>`;
  }
  return `<button type="button" class="btn btn-primary" data-shop="buy" data-id="${esc(s.id)}">Купить ${what} за ${coin(s.price)}</button>`;
}

function renderShop() {
  const shop = state.shop;
  if (!shop) return;
  $('shop-coins').textContent = shop.coins.toLocaleString('ru-RU');
  const { c, s } = shopSkin(state.shopSkin) || shopSkin(shop.selected);
  const locked = !s.owned;
  const skinsRow = c.skins.length > 1 ? `<div class="skin-row" role="group" aria-label="Образы">${c.skins.map((k) => {
    // Замок — только если сейчас купить нельзя: нет персонажа или не хватает монет.
    const closed = !k.owned && (k.needsCharacter || shop.coins < k.price);
    const tag = k.selected ? icon('i-check') : closed ? icon('i-lock') : '';
    return `<button type="button" class="skin-tab ${TIER_CLASS[k.tier]}${k.id === s.id ? ' on' : ''}${closed ? ' closed' : ''}" data-skin="${esc(k.id)}" aria-pressed="${k.id === s.id}" aria-label="${esc(k.name)}${closed ? ', закрыт' : ''}">
      <img src="/chars/${esc(k.id)}/front.webp" alt="" loading="lazy" decoding="async">
      <span class="skin-tier num">${k.tier}</span>${tag ? `<span class="skin-tag">${tag}</span>` : ''}
    </button>`;
  }).join('')}</div>` : '';
  const priceNote = s.owned ? (s.selected ? 'надет' : 'твой')
    : `<span class="coin" aria-hidden="true"></span><span class="num">${s.price}</span>`;
  $('shop-stage').innerHTML = `<div class="glass shop-stage">
    <div class="shop-stage-art ${TIER_CLASS[s.tier]}">
      <span class="dude-glow" aria-hidden="true"></span>
      ${locked ? (s.needsCharacter || shop.coins < s.price
    ? `<span class="stage-lock">${icon('i-lock')}${s.needsCharacter ? 'Нужен персонаж' : 'Закрыт'}</span>`
    : '<span class="stage-lock stage-open">Можно купить</span>') : ''}
      <span class="spin-hint">${icon('i-rotate')}крути</span>
      <div class="spin" data-spin="${esc(s.id)}" role="img" aria-label="${esc(c.name)}, ${esc(s.name)}: крути пальцем"></div>
    </div>
    <div class="shop-stage-info">
      <span class="shop-stage-name"><b>${esc(c.name)}</b><span>${esc(s.name)}</span></span>
      <span class="shop-stage-side"><span class="rarity ${TIER_CLASS[s.tier]}">${esc(s.rarity || '')}</span><span class="shop-price">${priceNote}</span></span>
    </div>
    ${skinsRow}
    ${shopButton(c, s, shop.coins)}
  </div>`;
  $('shop-grid').innerHTML = shop.characters.map((ch) => {
    const cover = charCover(ch);
    const wearing = ch.skins.some((k) => k.selected);
    const ownedCount = ch.skins.filter((k) => k.owned).length;
    let price;
    if (wearing) price = 'надет';
    else if (ch.owned) price = ch.skins.length > 1 ? `образов ${ownedCount} из ${ch.skins.length}` : 'есть';
    else price = `${shop.coins < ch.price ? icon('i-lock') : ''}<span class="coin" aria-hidden="true"></span><span class="num">${ch.price}</span>`;
    return `<button type="button" class="glass shop-card${ch.id === c.id ? ' picked' : ''}${!ch.owned && shop.coins < ch.price ? ' closed' : ''}" data-pick="${esc(ch.id)}" aria-pressed="${ch.id === c.id}">
      <span class="shop-card-art"><img src="/chars/${esc(cover.id)}/front.webp" alt="" loading="lazy" decoding="async"></span>
      <span class="shop-card-name">${esc(ch.name)}</span>
      <span class="shop-card-price">${price}</span>
    </button>`;
  }).join('');
  mountSpinners();
}

function pickShopCharacter(id) {
  const ch = state.shop && state.shop.characters.find((x) => x.id === id);
  if (!ch) return;
  pickShopSkin(charCover(ch).id);
  haptic('select');
  renderShop();
  // На телефоне витрина выше списка: возвращаемся к ней.
  if (window.innerWidth < 960) $('shop-stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function shopAction(action, id) {
  const found = shopSkin(id);
  if (!found) return;
  const { c, s } = found;
  const ok = action === 'buy'
    ? await confirmDialog(s.tier === 1
      ? `Купить персонажа ${c.name} за ${s.price} монет? Первый образ входит в покупку, остальные откроются для покупки.`
      : `Купить образ «${s.name}» для ${c.name} за ${s.price} монет?`)
    : true;
  if (!ok) return;
  try {
    state.shop = await api(`/api/shop/${action}`, { method: 'POST', body: { id } });
    haptic('success');
    if (state.profile) { state.profile.coins = state.shop.coins; state.profile.character = state.shop.selected; renderTop(); }
    toast(action === 'buy' ? (s.tier === 1 ? `${c.name} теперь твой` : 'Образ твой и уже надет') : 'Образ надет');
    renderShop();
  } catch (err) {
    haptic('error');
    toast(err.message);
  }
}


// ---------- Уведомления ----------

function setBadge(n) {
  const b = $('bell-badge');
  b.textContent = n > 9 ? '9+' : String(n);
  b.hidden = !n;
}

const NOTICE_ICON = { battle_invite: 'i-swords', battle_accepted: 'i-swords', battle_declined: 'i-swords', friend_added: 'i-user-plus', friend_joined: 'i-user-plus', week_winner: 'i-chart' };

function agoText(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return shortDayFmt.format(new Date(iso));
}

async function openNotices() {
  openPanel('<span class="league-tag">Уведомления</span>', '<div class="glass empty"><span class="spinner" aria-hidden="true"></span></div>', { notices: true });
  try {
    const data = await api('/api/notifications');
    if (!state.sheet || !state.sheet.notices) return;
    $('sheet-meta').innerHTML = `<span class="league-tag">Уведомления</span>${data.items.length
      ? '<button type="button" class="link notice-clear" id="notice-clear">Очистить</button>' : ''}`;
    $('sheet-body').innerHTML = data.items.length
      ? `<div class="glass list-card notice-list">${data.items.map((n) => `
          <button type="button" class="notice${n.read ? '' : ' unread'}" data-notice="${esc(n.link || '')}">
            <span class="notice-ic">${icon(NOTICE_ICON[n.kind] || 'i-bell')}</span>
            <span class="notice-main"><span>${esc(n.text)}</span><span class="notice-at">${esc(agoText(n.at))}</span></span>
            ${n.read ? '' : '<i class="notice-dot" aria-label="новое"></i>'}
          </button>`).join('')}</div>`
      : `<div class="glass empty"><svg class="ic ic-xl" aria-hidden="true"><use href="#i-bell"/></svg><b>Пока тихо</b>Здесь появятся вызовы на бой и новые друзья</div>`;
    if (data.items.some((n) => !n.read)) {
      await api('/api/notifications/read', { method: 'POST' });
      if (state.profile) state.profile.unread = 0;
      setBadge(0);
    }
  } catch (err) {
    $('sheet-body').innerHTML = `<div class="glass empty"><b>Не загрузилось</b>${esc(err.message)}</div>`;
  }
}

$('bell-btn').addEventListener('click', () => { haptic('light'); openNotices(); });

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#notice-clear')) return;
  const ok = await confirmDialog('Удалить все уведомления?');
  if (!ok) { openNotices(); return; }
  try {
    await api('/api/notifications/clear', { method: 'POST' });
    haptic('success');
    if (state.profile) state.profile.unread = 0;
    setBadge(0);
    openNotices();
  } catch (err) { toast(err.message); }
});

// ---------- Полный экран: одна кнопка «развернуть / свернуть» ----------

const FS_KEY = 'tochnyak_fullscreen';
// Кнопка только для компьютера: на телефоне приложение и так открыто на весь экран.
const tgFullscreen = () => Boolean(tg && !isPhone() && tg.requestFullscreen && tg.isVersionAtLeast && tg.isVersionAtLeast('8.0'));
const docFullscreen = () => Boolean(!tg && !isPhone() && document.documentElement.requestFullscreen && document.fullscreenEnabled);
const isFull = () => (tgFullscreen() ? Boolean(tg.isFullscreen) : Boolean(document.fullscreenElement));

function syncFsButton() {
  const b = $('fs-btn');
  if (!tgFullscreen() && !docFullscreen()) { b.hidden = true; return; }
  b.hidden = false;
  const full = isFull();
  b.setAttribute('aria-label', full ? 'Свернуть из полного экрана' : 'Развернуть на весь экран');
  b.setAttribute('aria-pressed', String(full));
  b.querySelector('use').setAttribute('href', full ? '#i-shrink' : '#i-expand');
}

function toggleFullscreen() {
  haptic('light');
  const full = isFull();
  try { localStorage.setItem(FS_KEY, full ? '0' : '1'); } catch { /* не страшно */ }
  try {
    if (tgFullscreen()) { if (full) tg.exitFullscreen(); else tg.requestFullscreen(); }
    else if (full) document.exitFullscreen(); else document.documentElement.requestFullscreen();
  } catch { /* клиент не дал — ничего страшного */ }
  setTimeout(syncFsButton, 400);
}

$('fs-btn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFsButton);
if (tg && tg.onEvent) { try { tg.onEvent('fullscreenChanged', syncFsButton); tg.onEvent('fullscreenFailed', syncFsButton); } catch { /* старые клиенты */ } }

document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-notice]');
  if (!n) return;
  const link = n.dataset.notice;
  const battle = /^#battle-([a-z0-9]{10})$/.exec(link);
  if (battle) openBattle(battle[1]);
  else if (link === '#friends') go('friends');
  else if (link === '#rating') go('rating');
  else closeSheet();
});

// Если друг кинул бой, пока тебя не было, — показываем вызов сразу при входе. Один раз за сессию на бой.
const shownInvites = new Set();
function showIncomingBattle() {
  if (!$('sheet').hidden || state.view === 'battle' || state.view === 'battle-new') return;
  const b = state.battles.find((x) => x.status === 'pending' && x.role === 'opponent' && x.needsMyPicks && !shownInvites.has(x.id));
  if (!b) return;
  shownInvites.add(b.id);
  haptic('success');
  openPanel('<span class="league-tag">Вызов на бой</span>', `
    <div class="invite-pop">
      <span class="invite-pop-vs">
        ${ava(b.opponent.name, b.opponent.photo, 'avatar-lg')}
        <span class="invite-pop-ic">${icon('i-swords')}</span>
        ${ava(state.profile && state.profile.firstName, state.profile && state.profile.photo, 'avatar-lg')}
      </span>
      <b>${esc(b.opponent.name)} бросает тебе вызов на бой</b>
      <span class="muted">${b.total} ${plural(b.total, ['матч', 'матча', 'матчей'])}, ${b.mode === 'outcome' ? 'на победу. Выбери, кто победит' : 'на точный счёт. Поставь свои счета'}, пока матчи не начались. Кто точнее, тот и выиграл бой.</span>
    </div>
    <button type="button" class="btn btn-primary" data-battle="${esc(b.id)}">${icon('i-swords')}Открыть бой</button>
    <button type="button" class="btn btn-ghost" data-close>Позже</button>`, { invite: b.id });
}

// ---------- Бои с друзьями ----------
// Двое ставят свои счета на одни и те же матчи. На интерес: аура и монеты за бой не начисляются.

const BATTLE_MAX = 30;
const BATTLE_RULES = {
  outcome: 'Угадал победителя или ничью — 1 очко. На интерес: аура и монеты не начисляются.',
  score: 'Точный счёт 3 · разница 2 · исход 1. На интерес: аура и монеты не начисляются.'
};
const OUT_SCORE = { home: { home: 1, away: 0 }, draw: { home: 0, away: 0 }, away: { home: 0, away: 1 } };

// Три кнопки П1 / Х / П2. ctx d — черновик нового боя, b — открытый бой.
function outChips(ctx, id, pick) {
  return `<span class="ochips" role="group" aria-label="Исход">${['home', 'draw', 'away'].map((k) =>
    `<button type="button" data-och="${ctx}:${id}:${k}" aria-pressed="${pick === k}">${OUT_LABEL[k]}</button>`).join('')}</span>`;
}

function chooseOut(spec) {
  const [ctx, id, key] = spec.split(':');
  const map = ctx === 'd' ? state.draft && state.draft.picks : state.battle && state.battle.edit;
  const p = map && map.get(Number(id));
  if (!p) return;
  p.pick = key;
  haptic('select');
  if (ctx === 'd') renderDraft(); else renderBattle();
}

const draftDefault = (mode) => (mode === 'outcome' ? { pick: null } : { home: 1, away: 0 });
const pickReady = (mode, p) => (mode === 'outcome' ? Boolean(p.pick) : true);
const pickBody = (mode, matchId, p) => (mode === 'outcome' ? { matchId, ...OUT_SCORE[p.pick] } : { matchId, home: p.home, away: p.away });

async function loadBattles() {
  try {
    const data = await api('/api/battles');
    state.battles = data.battles;
  } catch { return; }
  $('tab-dot').hidden = !state.battles.some((b) => b.needsMyPicks);
  if (state.view === 'friends') renderBattles();
  if (state.view === 'matches') renderBattleBanner();
}

function battleLabel(b) {
  if (b.status === 'done') {
    if (b.result === 'win') return ['Победа', 'win'];
    if (b.result === 'lose') return ['Поражение', 'lose'];
    return ['Ничья', 'draw'];
  }
  if (b.status === 'declined') return [b.role === 'creator' ? 'Отклонён' : 'Отклонён', 'mute'];
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
      <span><b>Боёв пока нет</b><span class="muted small">Нажми «Новый бой» выше или значок мечей рядом с другом в таблице.</span></span>
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
        ${ava(b.opponent.name, b.opponent.photo, 'avatar-sm')}
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
// today: сразу отмечаем все открытые матчи на сегодня, остаётся только выбрать исходы.
async function newBattle(code, name, today = false) {
  haptic('light');
  const fr = (state.friendRows || []).find((x) => x.code === code);
  state.draft = { code, name, photo: fr ? fr.photo : null, mode: 'outcome', picks: new Map() };
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
  if (today) {
    const todays = state.matches.filter((m) => m.open && dayDiff(m.utcDate) === 0).slice(0, BATTLE_MAX);
    for (const m of todays) state.draft.picks.set(m.id, draftDefault('outcome'));
    if (!todays.length) toast('Сегодня открытых матчей нет');
  }
  renderDraft();
}

function toggleDraft(id) {
  const d = state.draft;
  if (!d) return;
  if (d.picks.has(id)) d.picks.delete(id);
  else if (d.picks.size >= BATTLE_MAX) { toast(`В бою максимум ${BATTLE_MAX} матчей`); haptic('error'); return; }
  else d.picks.set(id, draftDefault(d.mode));
  haptic('select');
  renderDraft();
}

function draftRow(m, p, mode) {
  const time = `<span class="prow-time"><b class="num">${timeFmt.format(new Date(m.utcDate))}</b><span>${esc(LEAGUE_SHORT[m.competition] || league(m))}</span></span>`;
  // На победу: П1 / Х / П2 видны сразу, одно касание выбирает матч и исход, повторное — снимает.
  if (mode === 'outcome') {
    const pick = p ? p.pick : null;
    // Матч уже в бою, но исход не выбран (например, после «Бой на сегодняшние матчи»): подсвечиваем и даём убрать.
    const need = Boolean(p && !pick);
    return `<div class="prow prow-out${pick ? ' on' : ''}${need ? ' need' : ''}">
      <span class="prow-teams">
        <span class="prow-meta num">${timeFmt.format(new Date(m.utcDate))} · ${esc(LEAGUE_SHORT[m.competition] || league(m))}${need
          ? ` · <button type="button" class="prow-x" data-draft="${m.id}" aria-label="Убрать матч из боя">убрать</button>` : ''}</span>
        <span class="prow-team">${crest(m.home)}<b>${esc(m.home.short)}</b></span>
        <span class="prow-team">${crest(m.away)}<b>${esc(m.away.short)}</b></span>
      </span>
      <span class="ochips" role="group" aria-label="Исход">${['home', 'draw', 'away'].map((k) =>
        `<button type="button" data-dpick="${m.id}:${k}" aria-pressed="${pick === k}">${OUT_LABEL[k]}</button>`).join('')}</span>
    </div>`;
  }
  const team = (side) => `<span class="prow-team">${crest(m[side])}<b>${esc(m[side].short)}</b>${p && mode === 'score' ? miniStep('d', m.id, side, p[side], m[side].short) : ''}</span>`;
  return `<div class="prow${p ? ' on' : ''}"${p ? '' : ` data-draft="${m.id}" role="button" tabindex="0" aria-label="${esc(`Добавить ${m.home.short} — ${m.away.short}`)}"`}>
    <button type="button" class="prow-tick" data-draft="${m.id}" aria-pressed="${Boolean(p)}" aria-label="${p ? 'Убрать матч' : 'Добавить матч'}">${icon('i-check')}</button>
    <span class="prow-teams">${team('home')}${team('away')}</span>
    ${p && mode === 'outcome' ? outChips('d', m.id, p.pick) : p ? '' : time}
  </div>`;
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $('bn-friend').innerHTML = `<div class="glass versus-chip">
    ${ava(state.profile && state.profile.firstName, state.profile && state.profile.photo, 'avatar-sm')}<b>Ты</b>
    <span class="vs-mark">${icon('i-swords')}</span>
    <b>${esc(d.name)}</b>${ava(d.name, d.photo, 'avatar-sm')}
  </div>
  <div class="glass segmented" role="tablist" aria-label="Режим боя">
    <button type="button" role="tab" data-bmode="outcome" aria-selected="${d.mode === 'outcome'}">На победу</button>
    <button type="button" role="tab" data-bmode="score" aria-selected="${d.mode === 'score'}">На точный счёт</button>
  </div>
  <p class="hint">${d.mode === 'outcome' ? 'Жми П1, Х или П2 у любых матчей и кидай вызов.' : 'Нажми на матч и поставь счёт.'} ${esc(d.name)} сделает свои прогнозы, после матчей посмотрим, кто точнее. ${BATTLE_RULES[d.mode]}</p>`;
  const n = d.picks.size;
  const missing = [...d.picks.values()].filter((p) => !pickReady(d.mode, p)).length;
  $('bn-count').textContent = n ? `Выбрано ${n}` : 'Выбери матчи';
  $('bn-send').disabled = !n || missing > 0;
  $('bn-send').innerHTML = !n ? (d.mode === 'outcome' ? 'Нажми П1, Х или П2 у матча' : 'Выбери матчи')
    : missing ? `Выбери исход ещё в ${missing} ${plural(missing, ['матче', 'матчах', 'матчах'])}`
      : `${icon('i-swords')}Бросить вызов · <span class="num">${n}</span>`;
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
    <div class="glass list-card">${g.items.map((m) => draftRow(m, d.picks.get(m.id), d.mode)).join('')}</div>
  </section>`).join('');
}

function draftPick(spec) {
  const d = state.draft;
  if (!d) return;
  const [idStr, key] = spec.split(':');
  const id = Number(idStr);
  const cur = d.picks.get(id);
  if (cur && cur.pick === key) d.picks.delete(id);
  else if (!cur && d.picks.size >= BATTLE_MAX) { toast(`В бою максимум ${BATTLE_MAX} матчей`); haptic('error'); return; }
  else d.picks.set(id, { pick: key });
  haptic('select');
  renderDraft();
}

function setDraftMode(mode) {
  const d = state.draft;
  if (!d || d.mode === mode) return;
  d.mode = mode;
  for (const id of d.picks.keys()) d.picks.set(id, draftDefault(mode));
  haptic('select');
  renderDraft();
}

$('bn-send').addEventListener('click', async () => {
  const d = state.draft;
  if (!d || !d.picks.size) return;
  const btn = $('bn-send');
  btn.disabled = true;
  try {
    const picks = [...d.picks].map(([matchId, p]) => pickBody(d.mode, matchId, p));
    const res = await api('/api/battles', { method: 'POST', body: { friend: d.code, mode: d.mode, picks } });
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
      if (!it.open) continue;
      if (b.mode === 'outcome') edit.set(it.matchId, { pick: it.mine ? outcomeKey(it.mine) : null });
      else edit.set(it.matchId, it.mine ? { home: it.mine.home, away: it.mine.away } : { home: 1, away: 0 });
    }
  }
  state.battle = { battle: b, matches: data.matches, edit };
}

function battleNote(b) {
  const name = esc(b.opponent.name);
  const what = b.mode === 'outcome' ? 'выберет победителей' : 'поставит свои счета';
  if (b.status === 'pending' && b.role === 'creator') return `Ждём, когда ${name} примет бой и ${what}.`;
  if (b.status === 'pending') return `${name} бросает тебе вызов. ${b.mode === 'outcome' ? 'Выбери, кто победит' : 'Поставь свои счета'} и прими бой.`;
  if (b.status === 'active') return b.decided ? `Сыграно ${b.decided} из ${b.total}.` : 'Бой принят. Ждём матчи.';
  if (b.status === 'done') return b.result === 'win' ? 'Ты точнее. Красиво!' : b.result === 'lose' ? `В этот раз точнее ${name}.` : 'Одинаково точно.';
  if (b.status === 'declined') return b.role === 'creator' ? `${name}: бой отклонён.` : 'Бой отклонён.';
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

  if (b.mode === 'outcome') return battleItemOutcome(it, m, b, e, head, finished);
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

function battleItemOutcome(it, m, b, e, head, finished) {
  const pill = (x) => `<span class="opill${finished && x.pts > 0 ? ' hit' : ''}">${OUT_LABEL[outcomeKey(x)]}</span>`;
  const pts = (x) => (finished && x && x.pts != null ? `<span class="bpts${x.pts > 0 ? ' hit' : ''} num">+${x.pts}</span>` : '');
  const mine = e ? outChips('b', m.id, e.pick) : it.mine ? pill(it.mine) : '<span class="muted">—</span>';
  const t = it.theirs;
  const theirs = t && t.hidden ? `<span class="olock">${icon('i-lock')}скрыт</span>` : t ? pill(t) : `<span class="muted small">${it.open ? 'ждём' : '—'}</span>`;
  return `<div class="brow">
    <div class="brow-head"><span class="league-tag">${esc(league(m))}</span>${head}</div>
    <div class="bo-teams">${crest(m.home)}<b>${esc(m.home.short)}</b><span class="bo-dash">—</span><b>${esc(m.away.short)}</b>${crest(m.away)}</div>
    <div class="bo-row"><span class="bo-who">${ava(state.profile ? state.profile.firstName : 'Ты', state.profile && state.profile.photo, 'avatar-xs')}<b>Ты</b></span><span class="bo-val">${mine}${pts(it.mine)}</span></div>
    <div class="bo-row"><span class="bo-who">${ava(b.opponent.name, b.opponent.photo, 'avatar-xs')}<b>${esc(b.opponent.name)}</b></span><span class="bo-val">${theirs}${t && !t.hidden ? pts(t) : ''}</span></div>
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
    if (!e) return false;
    if (b.mode === 'outcome') return Boolean(e.pick) && (!it.mine || outcomeKey(it.mine) !== e.pick);
    return !it.mine || it.mine.home !== e.home || it.mine.away !== e.away;
  });
  let save = '';
  if (edit.size && (dirty || b.needsMyPicks)) {
    const text = b.status === 'pending' && b.role === 'opponent' ? 'Принять бой' : b.mode === 'outcome' ? 'Сохранить прогнозы' : 'Сохранить счета';
    save = `<button type="button" class="btn btn-primary" data-bact="save">${icon(b.status === 'pending' ? 'i-swords' : 'i-lock')}${text}</button>`;
  }
  let close = '';
  if (b.status === 'pending') close = `<button type="button" class="btn btn-ghost" data-bact="close">${b.role === 'opponent' ? 'Отказаться' : 'Отменить бой'}</button>`;
  const big = b.status === 'done' ? `<span class="bverdict bverdict-${cls}">${label}</span>` : `<span class="bstate bstate-${cls}">${label}</span>`;
  $('battle-body').innerHTML = `
    <div class="glass bhero bhero-${cls}">
      <div class="bhero-vs">
        <span class="bside">${ava(me, state.profile && state.profile.photo)}<b>Ты</b></span>
        <span class="bscore num">${b.score.me}<i>:</i>${b.score.them}</span>
        <span class="bside">${ava(b.opponent.name, b.opponent.photo)}<b>${esc(b.opponent.name)}</b></span>
      </div>
      ${big}
      <p class="bhero-note">${battleNote(b)}</p>
    </div>
    <p class="hint"><b class="mode-tag">${b.mode === 'outcome' ? 'На победу' : 'На точный счёт'}</b> ${BATTLE_RULES[b.mode]} Прогноз друга виден, когда на матч закрывается приём.</p>
    <div class="glass list-card">${b.items.map((it) => (byId.has(it.matchId) ? battleItem(it, byId.get(it.matchId), b, edit) : '')).join('')}</div>
    ${save}${close}${b.decided > 0 ? `<button type="button" class="btn btn-glass" data-bact="share">${icon('i-share')}Поделиться итогом</button>` : ''}`;
}

async function battleAction(action) {
  const sb = state.battle;
  if (!sb) return;
  const b = sb.battle;
  if (action === 'share') { openBattleShare(); return; }
  if (action === 'save') {
    const picks = [...sb.edit].filter(([, p]) => pickReady(b.mode, p)).map(([matchId, p]) => pickBody(b.mode, matchId, p));
    if (!picks.length) { toast('Выбери исход хотя бы в одном матче'); haptic('error'); return; }
    try {
      const res = await api(`/api/battles/${b.id}/picks`, { method: 'POST', body: { picks } });
      const accepted = b.status === 'pending' && b.role === 'opponent';
      setBattle(res);
      renderBattle();
      haptic('success');
      toast(accepted ? 'Бой принят' : res.skipped ? 'Сохранено. Часть матчей уже закрылась' : 'Сохранено');
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
      toast(b.role === 'opponent' ? 'Бой отклонён' : 'Бой отменён');
      state.battle = null;
      go('friends');
    } catch (err) { toast(err.message); }
  }
}

// ---------- Персонаж, которого можно крутить пальцем ----------
// У Точняка четыре ракурса (спереди, справа, сзади, слева): между ними он плавно «доворачивается» —
// сужается к ребру и раскрывается следующим ракурсом. У остальных персонажей 12 кадров поворота:
// кадры просто сменяют друг друга. После броска пальцем персонаж крутится по инерции.

const VIEWS4 = ['front', 'right', 'back', 'left'];
const FRAMES12 = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const DEG_PER_PX = 1.1;
const spin = { angle: 0, els: new Set(), raf: 0, velocity: 0, dragging: false, touchedAt: 0, autoRaf: 0, autoPrev: 0 };
const AUTO_DEG_PER_MS = 0.024; // сам по себе медленно крутится, как на витрине
const AUTO_PAUSE_MS = 2500;    // после касания ждём, прежде чем снова крутить
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Медленное вращение, пока персонажа не трогают. Без вибрации и только когда он на экране.
function autoSpin(now) {
  spin.autoRaf = 0;
  const live = [...spin.els].some((el) => el.isConnected && el.offsetParent !== null);
  if (!live || reduceMotion() || document.hidden) { spin.autoPrev = 0; return; }
  const dt = spin.autoPrev ? Math.min(50, now - spin.autoPrev) : 0;
  spin.autoPrev = now;
  if (!spin.dragging && Math.abs(spin.velocity) <= 0.03 && now - spin.touchedAt > AUTO_PAUSE_MS) {
    spin.angle += dt * AUTO_DEG_PER_MS;
    paintSpin();
  }
  spin.autoRaf = requestAnimationFrame(autoSpin);
}
function startAutoSpin() {
  if (!spin.autoRaf) { spin.autoPrev = 0; spin.autoRaf = requestAnimationFrame(autoSpin); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) startAutoSpin(); });

function spinStep() {
  // Остановка на ближайшем ракурсе: у Точняка через 90°, у остальных через 30°.
  // Считаем только видимых: Точняк в скрытом профиле не должен мешать крутить образ в магазине.
  for (const el of spin.els) if (el.isConnected && el.offsetParent !== null && el.dataset.frames === '4') return 90;
  return 30;
}

function mountSpinners() {
  document.querySelectorAll('[data-spin]').forEach((el) => {
    spin.els.add(el);
    const id = el.dataset.spin || 'tochnyak';
    if (el.dataset.ready === id) return;
    el.dataset.ready = id;
    const n = skinFrames(id);
    el.dataset.frames = String(n);
    const names = n === 4 ? VIEWS4 : FRAMES12;
    el.innerHTML = `<div class="spin-imgs${n === 4 ? '' : ' r23'}">`
      + names.map((v, k) => `<img src="/chars/${encodeURIComponent(id)}/${v}.webp" alt="" draggable="false" decoding="async"${k ? ' loading="eager"' : ''}>`).join('')
      + '</div><span class="spin-floor" aria-hidden="true"></span>';
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    let lastX = 0; let lastT = 0;
    // iOS: не даём странице и Telegram уехать, пока палец крутит персонажа.
    el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    el.addEventListener('pointerdown', (e) => {
      spin.dragging = true; spin.velocity = 0; spin.touchedAt = performance.now();
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
      spin.touchedAt = performance.now();
      el.classList.remove('grab');
      if (performance.now() - lastT > 80) spin.velocity = 0;
      coast();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  });
  paintSpin();
  startAutoSpin();
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
  const stepDeg = spinStep();
  const step = (now) => {
    const dt = Math.min(40, now - prev); prev = now;
    if (Math.abs(spin.velocity) > 0.03) {
      spin.touchedAt = now;
      setAngle(spin.angle + spin.velocity * dt);
      spin.velocity *= Math.pow(0.993, dt);
      spin.raf = requestAnimationFrame(step);
      return;
    }
    const target = Math.round(spin.angle / stepDeg) * stepDeg;
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
  for (const el of spin.els) {
    if (!el.isConnected) { spin.els.delete(el); continue; }
    const n = Number(el.dataset.frames) || 4;
    const pos = ((spin.angle / (360 / n)) % n + n) % n;
    const i = Math.floor(pos);
    const j = (i + 1) % n;
    const p = pos - i;
    let oi; let oj; let sx = 1;
    if (n === 4) {
      // Ширина: полная на ракурсе, вдвое уже на середине поворота (человек в профиль тоже уже).
      sx = 0.55 + 0.45 * Math.abs(Math.cos(Math.PI * p));
      oi = clamp01((0.58 - p) / 0.16);
      oj = clamp01((p - 0.42) / 0.16);
    } else {
      // Соседние кадры: следующий плавно проявляется поверх текущего (без «просвечивания» насквозь),
      // поэтому 12 кадров читаются как непрерывный поворот.
      const t = clamp01((p - 0.15) / 0.7);
      oj = t * t * (3 - 2 * t);
      oi = p < 0.85 ? 1 : 0;
    }
    el.querySelectorAll('.spin-imgs img').forEach((img, k) => {
      const o = k === i ? oi : k === j ? oj : 0;
      img.style.opacity = String(o);
      img.style.zIndex = k === j ? '2' : '1';
      img.style.transform = o && n === 4 ? `scaleX(${sx.toFixed(3)})` : '';
    });
  }
}

boot();
