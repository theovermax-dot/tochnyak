// Точняк: Cloudflare Worker. Раздаёт мини-апп (папка public), отвечает на API,
// принимает сообщения бота и раз в 10 минут обновляет матчи.

import { ensureSchema, nowIso, newFriendCode } from './db.js';
import { validateInitData, botApi } from './telegram.js';
import { syncAndSettle } from './footballData.js';
import { COINS } from './scoring.js';
import { CHARACTERS, DEFAULT_CHARACTER, characterById } from './characters.js';
import { teamName } from './teams.js';
import { profileStats } from './stats.js';
import { weekStartIso } from './week.js';
import { runBotJobs } from './jobs.js';
import { BATTLE_ID, createBattle, savePicks, closeBattle, listBattles, getBattle, deleteUserBattles } from './battles.js';

const MAX_GOALS = 15;
const MAX_FRIENDS = 300;
const FRIEND_CODE = /^[a-z0-9]{8}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (status, code, message) => json({ error: code, message }, status);

export { weekStartIso };

function lockMs(env) {
  return Number(env.LOCK_MINUTES || 5) * 60000;
}

function botUsername(env) {
  return env.BOT_USERNAME || 'tochnyak_bot';
}

// direct: ссылка сразу открывает мини-апп (нужен Main Mini App в BotFather), иначе — чат с ботом.
// ref — ник игрока в Telegram (красиво: ?start=kellluss) или код f_xxxxxxxx, если ника нет.
function inviteLink(env, ref, direct = false) {
  return `https://t.me/${botUsername(env)}?${direct ? 'startapp' : 'start'}=${ref}`;
}

// Что подставлять в ссылку-приглашение: ник, если он есть и не похож на код, иначе код.
const USERNAME_REF = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
function refFor(username, code) {
  return username && USERNAME_REF.test(username) ? username : `f_${code}`;
}

// Разбирает то, что пришло из ссылки: f_код, код или ник. Возвращает игрока или null.
async function resolveRef(db, raw) {
  const str = String(raw || '');
  const byCode = (c) => db.prepare('SELECT id, first_name, friend_code FROM users WHERE friend_code = ?1').bind(c).first();
  const byName = (n) => db.prepare('SELECT id, first_name, friend_code FROM users WHERE username = ?1 COLLATE NOCASE').bind(n).first();
  // f_xxxxxxxx — точно код.
  if (str.startsWith('f_')) return FRIEND_CODE.test(str.slice(2)) ? (await byCode(str.slice(2))) || null : null;
  // Без приставки — сначала ник, потом код (старые ссылки ?f=код).
  if (USERNAME_REF.test(str)) {
    const n = await byName(str);
    if (n) return n;
  }
  if (FRIEND_CODE.test(str)) return (await byCode(str)) || null;
  return null;
}

// Включён ли у бота Main Mini App. Спрашиваем Telegram раз в 10 минут; MAIN_APP=1/0 в настройках перекрывает.
let mainAppCache = { value: false, at: 0 };
async function hasMainApp(env, now = Date.now()) {
  if (env.MAIN_APP === '1') return true;
  if (env.MAIN_APP === '0' || !env.BOT_TOKEN) return false;
  if (now - mainAppCache.at < 600000) return mainAppCache.value;
  try {
    const res = await Promise.race([
      botApi(env.BOT_TOKEN, 'getMe', {}),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500))
    ]);
    if (res && res.ok) mainAppCache = { value: Boolean(res.result && res.result.has_main_web_app), at: now };
  } catch { /* оставим прошлое значение */ }
  return mainAppCache.value;
}

const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Текст приглашения: приходит другу под картинкой вместе с кнопкой.
export function inviteCaption(name) {
  const who = escHtml(String(name || '').trim().slice(0, 32) || 'Друг');
  return [
    `<b>${who} приглашает тебя в Точняк 🎯</b>`,
    '',
    'Го угадывать матчи: АПЛ, Ла Лига, Лига чемпионов и ещё четыре лиги.',
    '',
    'Угадал победителя — <b>+2 ауры</b>, точный счёт — <b>до +12</b>. В конце недели смотрим, кто из нас точнее.',
    '',
    'Бесплатно и без ставок. Жми 👇'
  ].join('\n');
}

// Приветствие бота на /start. inviter — имя пригласившего, если человек пришёл по ссылке друга.
export function welcomeCaption(inviter) {
  const head = inviter
    ? `<b>${escHtml(String(inviter).slice(0, 32))} приглашает тебя в Точняк</b>`
    : '<b>Точняк — угадай, чем закончится матч</b>';
  return [
    head,
    '',
    'Угадывай победителя или точный счёт в матчах АПЛ, Ла Лиги, Серии А, Бундеслиги, Лиги 1, Эредивизи и Лиги чемпионов.',
    '',
    '✅ Победитель — <b>+2 ауры</b>, точный счёт — <b>до +12</b>',
    '⚔️ Бои с друзьями по нескольким матчам',
    '🏆 Недельный рейтинг и таблица друзей',
    '🛍 Монеты на новых персонажей',
    '',
    'Вход в один шаг через Telegram. Игра бесплатная: без ставок и без денег.'
  ].join('\n');
}

// ?v= сбрасывает старый кэш эмблем в Telegram.
const crestUrl = (file) => (file ? `/crest/${file}?v=2` : null);

function matchOut(m, env, now) {
  const lockAt = new Date(Date.parse(m.utc_date) - lockMs(env)).toISOString();
  return {
    id: m.id,
    competition: m.competition,
    competitionName: m.competition_name,
    utcDate: m.utc_date,
    lockAt,
    open: now < Date.parse(lockAt) && ['SCHEDULED', 'TIMED'].includes(m.status),
    status: m.status,
    home: { name: m.home_name, short: teamName(m.home_short, m.home_name), tla: m.home_tla, crest: crestUrl(m.home_crest) },
    away: { name: m.away_name, short: teamName(m.away_short, m.away_name), tla: m.away_tla, crest: crestUrl(m.away_crest) },
    score: m.home_score == null ? null : { home: m.home_score, away: m.away_score },
    prediction: m.pred_home == null ? null : { home: m.pred_home, away: m.pred_away, points: m.pred_points, kind: m.pred_kind || 'score' }
  };
}

async function ownedSet(db, userId) {
  const { results } = await db.prepare('SELECT character_id FROM owned_characters WHERE user_id = ?1').bind(userId).all();
  const set = new Set(results.map((r) => r.character_id));
  for (const c of CHARACTERS) if (c.price === 0) set.add(c.id);
  return set;
}

async function shopState(db, userId) {
  const user = await db.prepare('SELECT coins, character FROM users WHERE id = ?1').bind(userId).first();
  const owned = await ownedSet(db, userId);
  const selected = characterById(user.character) ? user.character : DEFAULT_CHARACTER;
  return {
    coins: user.coins || 0,
    selected,
    items: CHARACTERS.map((c) => ({ ...c, owned: owned.has(c.id), selected: c.id === selected }))
  };
}

// Выдаёт игроку код приглашения, если его ещё нет.
async function ensureFriendCode(db, userId) {
  for (let i = 0; i < 3; i += 1) {
    const row = await db.prepare('SELECT friend_code FROM users WHERE id = ?1').bind(userId).first();
    if (!row || row.friend_code) return row ? row.friend_code : null;
    try {
      await db.prepare('UPDATE users SET friend_code = ?1 WHERE id = ?2 AND friend_code IS NULL').bind(newFriendCode(), userId).run();
    } catch { /* совпал код, пробуем ещё раз */ }
  }
  return null;
}

// Номер храним только цифрами: из «+7 (999) 123-45-67» получится 79991234567.
export function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Поиск игрока по @username или номеру. Номер ищем по последним 10 цифрам, чтобы 8 и +7 совпадали.
async function findPlayer(db, query) {
  const q = String(query || '').trim();
  const name = /^@?([A-Za-z0-9_]{3,32})$/.exec(q);
  if (name && !/^\d+$/.test(name[1])) {
    return db.prepare('SELECT id, first_name, friend_code FROM users WHERE username = ?1 COLLATE NOCASE').bind(name[1]).first();
  }
  const phone = normPhone(q);
  if (phone) {
    return db.prepare('SELECT id, first_name, friend_code FROM users WHERE phone IS NOT NULL AND substr(phone, -10) = ?1')
      .bind(phone.slice(-10)).first();
  }
  return undefined;
}

async function addFriend(db, userId, code, now, { bonus = true } = {}) {
  const raw = String(code || '');
  if (!FRIEND_CODE.test(raw.replace(/^f_/, '')) && !USERNAME_REF.test(raw)) return { error: [400, 'bad_code', 'Ссылка-приглашение не подходит'] };
  const friend = await resolveRef(db, raw);
  if (!friend) return { error: [404, 'no_friend', 'Игрок по этой ссылке не найден'] };
  if (friend.id === userId) return { self: true };
  const count = await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?1').bind(userId).first();
  if (count.n >= MAX_FRIENDS) return { error: [409, 'too_many', 'Друзей уже слишком много'] };
  const at = nowIso(now);
  const res = await db.batch([
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)').bind(userId, friend.id, at),
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)').bind(friend.id, userId, at)
  ]);
  const added = Boolean(res[0] && res[0].meta && res[0].meta.changes);
  // Монеты пригласившему: только за новичка, который пришёл в первые сутки после регистрации.
  if (added && bonus) {
    const me = await db.prepare('SELECT created_at FROM users WHERE id = ?1').bind(userId).first();
    if (me && now - Date.parse(me.created_at) < 86400000) {
      await db.prepare('UPDATE users SET coins = coins + ?1 WHERE id = ?2').bind(COINS.friendJoined, friend.id).run();
    }
  }
  return { added, name: friend.first_name || 'Игрок', friendId: friend.id };
}

// Фоновая задача: Worker не ждёт её, но и не обрывает.
function later(ctx, task) {
  if (!ctx || !ctx.waitUntil) return;
  ctx.waitUntil(Promise.resolve().then(task).catch(() => {}));
}

// Сообщение игроку от бота с кнопкой в мини-апп. Если он не запускал бота, Telegram просто откажет.
// Уведомление в приложении (колокольчик). link — куда вести по нажатию: #battle-<id>, #friends.
async function addNotice(db, userId, kind, text, link, now = Date.now()) {
  await db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(userId, kind, text, link || null, nowIso(now)).run();
  // Храним последние 50 на человека.
  await db.prepare(`DELETE FROM notifications WHERE user_id = ?1 AND id NOT IN
    (SELECT id FROM notifications WHERE user_id = ?1 ORDER BY id DESC LIMIT 50)`).bind(userId).run();
}

function notify(env, chatId, text, button, webUrl) {
  if (!env.BOT_TOKEN) return null;
  return botApi(env.BOT_TOKEN, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: button, web_app: { url: webUrl } }]] }
  });
}

async function currentTelegramUser(request, env) {
  const initData = request.headers.get('x-telegram-init-data');
  return validateInitData(initData, env.BOT_TOKEN);
}

async function loadProfile(db, userId, now) {
  const user = await db.prepare('SELECT id, first_name, username, phone, photo_url, aura, coins, character, created_at FROM users WHERE id = ?1').bind(userId).first();
  if (!user) return null;
  const weekStart = weekStartIso(now);
  const week = await db.prepare(
    'SELECT COALESCE(SUM(points), 0) AS pts, COUNT(*) AS n FROM predictions WHERE user_id = ?1 AND settled_at >= ?2'
  ).bind(userId, weekStart).first();
  const { results: settled } = await db.prepare(
    `SELECT m.competition, p.points, p.kind, p.home, p.away, m.home_score AS hs, m.away_score AS ast
     FROM predictions p JOIN matches m ON m.id = p.match_id
     WHERE p.user_id = ?1 AND p.settled_at IS NOT NULL
     ORDER BY p.settled_at DESC, p.match_id DESC LIMIT 500`
  ).bind(userId).all();
  const stats = profileStats(settled);
  return {
    id: user.id,
    firstName: user.first_name,
    username: user.username || null,
    photo: user.photo_url || null,
    hasPhone: Boolean(user.phone),
    aura: user.aura,
    coins: user.coins || 0,
    character: characterById(user.character) ? user.character : DEFAULT_CHARACTER,
    weekAura: week.pts,
    settledPredictions: stats.total,
    exactHits: stats.exact,
    streak: stats.streak,
    leagues: stats.leagues,
    joinedAt: user.created_at,
    friendCode: await ensureFriendCode(db, userId),
    friendsCount: (await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?1').bind(userId).first()).n,
    unread: (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL').bind(userId).first()).n
  };
}

// Текущая версия регистрации. Подняли номер — и все, у кого версия меньше, при следующем входе
// снова видят экран согласия и шаг с номером. Аура, прогнозы и друзья при этом сохраняются.
export const REG_VERSION = 2;

async function handleApi(request, env, url, now, ctx) {
  const db = env.DB;
  const tgUser = await currentTelegramUser(request, env);
  if (!tgUser) return error(401, 'unauthorized', 'Откройте приложение через Telegram');

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/me' && method === 'GET') {
    const profile = await loadProfile(db, tgUser.id, now);
    if (!profile) return json({ registered: false, firstName: tgUser.firstName, photo: tgUser.photoUrl });
    const reg = await db.prepare('SELECT reg_version FROM users WHERE id = ?1').bind(tgUser.id).first();
    if (reg.reg_version < REG_VERSION) return json({ registered: false, returning: true, firstName: tgUser.firstName, photo: tgUser.photoUrl });
    await db.prepare('UPDATE users SET last_seen_at = ?1, first_name = ?2, username = ?3, language_code = ?4, photo_url = ?6 WHERE id = ?5')
      .bind(nowIso(now), tgUser.firstName, tgUser.username, tgUser.languageCode, tgUser.id, tgUser.photoUrl).run();
    profile.photo = tgUser.photoUrl;
    return json({ registered: true, profile });
  }

  if (path === '/api/auth' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.accept !== true) return error(400, 'consent_required', 'Нужно согласие с правилами и политикой конфиденциальности');
    const at = nowIso(now);
    await db.prepare(`INSERT INTO users (id, first_name, username, language_code, aura, accepted_terms_at, created_at, last_seen_at, reg_version, photo_url)
      VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?5, ?6, ?7)
      ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
        language_code = excluded.language_code, last_seen_at = excluded.last_seen_at,
        accepted_terms_at = excluded.accepted_terms_at, reg_version = excluded.reg_version, photo_url = excluded.photo_url`)
      .bind(tgUser.id, tgUser.firstName, tgUser.username, tgUser.languageCode, at, REG_VERSION, tgUser.photoUrl).run();
    return json({ registered: true, profile: await loadProfile(db, tgUser.id, now) });
  }

  // Дальше только для зарегистрированных.
  const exists = await db.prepare('SELECT reg_version FROM users WHERE id = ?1').bind(tgUser.id).first();
  if (!exists) return error(403, 'not_registered', 'Сначала войдите в приложение');
  // Удалить аккаунт можно и без повторной регистрации.
  if (exists.reg_version < REG_VERSION && !(path === '/api/me' && method === 'DELETE')) {
    return error(403, 'reg_update', 'Пройди регистрацию заново');
  }

  if (path === '/api/me' && method === 'DELETE') {
    await deleteUserBattles(db, tgUser.id);
    await db.batch([
      db.prepare('DELETE FROM predictions WHERE user_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM notifications WHERE user_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM owned_characters WHERE user_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM support_map WHERE user_chat_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM users WHERE id = ?1').bind(tgUser.id)
    ]);
    return json({ deleted: true });
  }

  if (path === '/api/matches' && method === 'GET') {
    const from = new Date(now - 2 * 86400000).toISOString();
    const to = new Date(now + 8 * 86400000).toISOString();
    const { results } = await db.prepare(
      `SELECT m.*, p.home AS pred_home, p.away AS pred_away, p.points AS pred_points, p.kind AS pred_kind
       FROM matches m LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?1
       WHERE m.utc_date BETWEEN ?2 AND ?3 AND m.status NOT IN ('CANCELLED')
       ORDER BY m.utc_date, m.id`
    ).bind(tgUser.id, from, to).all();
    return json({ matches: results.map((m) => matchOut(m, env, now)), now: nowIso(now) });
  }

  // Мои прогнозы: будущие и сыгранные, свежие сверху.
  if (path === '/api/my' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT m.*, p.home AS pred_home, p.away AS pred_away, p.points AS pred_points, p.kind AS pred_kind
       FROM predictions p JOIN matches m ON m.id = p.match_id
       WHERE p.user_id = ?1 ORDER BY m.utc_date DESC, m.id DESC LIMIT 100`
    ).bind(tgUser.id).all();
    return json({ items: results.map((m) => matchOut(m, env, now)) });
  }

  // Магазин персонажей.
  if (path === '/api/shop' && method === 'GET') {
    return json(await shopState(db, tgUser.id));
  }

  if (path === '/api/shop/buy' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ch = characterById(body.id);
    if (!ch) return error(404, 'no_character', 'Такого персонажа нет');
    const owned = await ownedSet(db, tgUser.id);
    if (owned.has(ch.id)) return json(await shopState(db, tgUser.id));
    // Сначала «бронируем» персонажа: повторный запрос не спишет монеты дважды.
    const claim = await db.prepare(`INSERT OR IGNORE INTO owned_characters (user_id, character_id, bought_at, price)
      VALUES (?1, ?2, ?3, ?4)`).bind(tgUser.id, ch.id, nowIso(now), ch.price).run();
    if (!claim.meta.changes) return json(await shopState(db, tgUser.id));
    const paid = await db.prepare('UPDATE users SET coins = coins - ?1, character = ?2 WHERE id = ?3 AND coins >= ?1')
      .bind(ch.price, ch.id, tgUser.id).run();
    if (!paid.meta.changes) {
      await db.prepare('DELETE FROM owned_characters WHERE user_id = ?1 AND character_id = ?2').bind(tgUser.id, ch.id).run();
      return error(409, 'not_enough', 'Не хватает монет');
    }
    return json(await shopState(db, tgUser.id));
  }

  if (path === '/api/shop/select' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ch = characterById(body.id);
    if (!ch) return error(404, 'no_character', 'Такого персонажа нет');
    const owned = await ownedSet(db, tgUser.id);
    if (!owned.has(ch.id)) return error(403, 'not_owned', 'Сначала купи этого персонажа');
    await db.prepare('UPDATE users SET character = ?1 WHERE id = ?2').bind(ch.id, tgUser.id).run();
    return json(await shopState(db, tgUser.id));
  }

  // Бои с друзьями.
  if (path === '/api/battles' && method === 'GET') {
    return json({ battles: await listBattles(db, { userId: tgUser.id, now, lockMs: lockMs(env) }) });
  }

  if (path === '/api/battles' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'score' ? 'score' : 'outcome';
    const res = await createBattle(db, { userId: tgUser.id, friendCode: body.friend, picks: body.picks, mode, now, lockMs: lockMs(env) });
    if (res.error) return error(...res.error);
    await addNotice(db, res.opponentId, 'battle_invite', `${tgUser.firstName || 'Друг'} бросает тебе вызов на бой · ${body.picks.length} ${body.picks.length === 1 ? 'матч' : body.picks.length < 5 ? 'матча' : 'матчей'}`, `#battle-${res.id}`, now);
    later(ctx, () => notify(env, res.opponentId,
      `⚔️ <b>${escHtml(tgUser.firstName || 'Друг')} бросает тебе вызов на бой</b>\n\nМатчей в бою: ${body.picks.length}, ${mode === 'outcome' ? 'ставим на победу' : 'ставим точный счёт'}. Делай прогнозы, пока матчи не начались. Победит тот, кто окажется точнее.`,
      'Принять бой', `${url.origin}/#battle-${res.id}`));
    return json({ id: res.id });
  }

  const battlePath = /^\/api\/battles\/([a-z0-9]{10})(?:\/(picks|close))?$/.exec(path);
  if (battlePath && BATTLE_ID.test(battlePath[1])) {
    const battleId = battlePath[1];
    const action = battlePath[2];
    if (!action && method === 'GET') {
      const res = await getBattle(db, { battleId, userId: tgUser.id, now, lockMs: lockMs(env) });
      if (!res) return error(404, 'no_battle', 'Бой не найден');
      const nowMs = now;
      return json({ battle: res.battle, matches: res.matches.map((m) => matchOut(m, env, nowMs)) });
    }
    if (action === 'picks' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const res = await savePicks(db, { battleId, userId: tgUser.id, picks: body.picks, now, lockMs: lockMs(env) });
      if (res.error) return error(...res.error);
      if (res.accepted) {
        await addNotice(db, res.creatorId, 'battle_accepted', `${tgUser.firstName || 'Друг'} принимает твой бой`, `#battle-${battleId}`, now);
        later(ctx, () => notify(env, res.creatorId,
          `🔥 <b>${escHtml(tgUser.firstName || 'Друг')} принимает бой</b>\n\nПрогнозы друг друга откроются, когда начнутся матчи. Итог — после финального свистка.`,
          'Открыть бой', `${url.origin}/#battle-${battleId}`));
      }
      const res2 = await getBattle(db, { battleId, userId: tgUser.id, now, lockMs: lockMs(env) });
      return json({ saved: res.saved, skipped: res.skipped, battle: res2.battle, matches: res2.matches.map((m) => matchOut(m, env, now)) });
    }
    if (action === 'close' && method === 'POST') {
      const res = await closeBattle(db, { battleId, userId: tgUser.id });
      if (res.error) return error(...res.error);
      if (res.status === 'declined') await addNotice(db, res.creatorId, 'battle_declined', `${tgUser.firstName || 'Друг'} отклоняет твой бой`, `#battle-${battleId}`, now);
      return json(res);
    }
  }

  // Найти игрока по @username или номеру и сразу добавить в друзья.
  if (path === '/api/friends/find' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const found = await findPlayer(db, body.query);
    if (found === undefined) return error(400, 'bad_query', 'Введи @username или номер телефона');
    if (!found) return error(404, 'not_found', 'Такого игрока пока нет в Точняке. Позови его по ссылке');
    if (found.id === tgUser.id) return error(400, 'self', 'Это ты');
    const code = found.friend_code || (await ensureFriendCode(db, found.id));
    const res = await addFriend(db, tgUser.id, code, now, { bonus: false });
    if (res.error) return error(...res.error);
    if (res.added) {
      await addNotice(db, found.id, 'friend_added', `Новый друг: ${tgUser.firstName || 'Игрок'}. Вы теперь в одной таблице`, '#friends', now);
      later(ctx, () => notify(env, found.id,
        `👋 <b>Новый друг в Точняке: ${escHtml(tgUser.firstName || 'Игрок')}</b>\n\nТеперь вы в одной таблице и можете вызывать друг друга на бой.`,
        'Открыть друзей', `${url.origin}/#friends`));
    }
    return json({ added: res.added, name: found.first_name || 'Игрок' });
  }

  // Отвязать номер.
  // Уведомления.
  if (path === '/api/notifications' && method === 'GET') {
    const { results } = await db.prepare(
      'SELECT id, kind, text, link, created_at, read_at FROM notifications WHERE user_id = ?1 ORDER BY id DESC LIMIT 50'
    ).bind(tgUser.id).all();
    return json({ items: results.map((n) => ({ id: n.id, kind: n.kind, text: n.text, link: n.link, at: n.created_at, read: Boolean(n.read_at) })) });
  }
  if (path === '/api/notifications/read' && method === 'POST') {
    await db.prepare('UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL').bind(nowIso(now), tgUser.id).run();
    return json({ ok: true });
  }

  if (path === '/api/me/phone' && method === 'DELETE') {
    await db.prepare('UPDATE users SET phone = NULL WHERE id = ?1').bind(tgUser.id).run();
    return json({ ok: true });
  }

  if (path === '/api/friends' && method === 'GET') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
    const code = await ensureFriendCode(db, tgUser.id);
    const ref = refFor(tgUser.username, code);
    const circle = 'u.id = ?1 OR u.id IN (SELECT friend_id FROM friends WHERE user_id = ?1)';
    const { results } = period === 'all'
      ? await db.prepare(`SELECT u.id, u.first_name, u.friend_code, u.photo_url, u.aura AS pts FROM users u
          WHERE ${circle} ORDER BY pts DESC, u.id`).bind(tgUser.id).all()
      : await db.prepare(`SELECT u.id, u.first_name, u.friend_code, u.photo_url, COALESCE(SUM(p.points), 0) AS pts FROM users u
          LEFT JOIN predictions p ON p.user_id = u.id AND p.settled_at >= ?2
          WHERE ${circle} GROUP BY u.id ORDER BY pts DESC, u.id`).bind(tgUser.id, weekStartIso(now)).all();
    return json({
      period,
      code,
      link: code ? inviteLink(env, ref, await hasMainApp(env, now)) : null,
      // Страница с большой картинкой-превью: для соцсетей, которые не показывают превью t.me.
      shareLink: code ? `${url.origin}/i/${code}` : null,
      rows: results.map((r, i) => ({
        rank: i + 1,
        name: r.first_name || 'Игрок',
        photo: r.photo_url || null,
        pts: r.pts,
        isMe: r.id === tgUser.id,
        code: r.id === tgUser.id ? null : r.friend_code
      }))
    });
  }

  // Готовое сообщение-приглашение с картинкой: Telegram покажет выбор чата и отправит его от имени игрока.
  if (path === '/api/invite' && method === 'POST') {
    const code = await ensureFriendCode(db, tgUser.id);
    if (!code) return error(500, 'no_code', 'Не получилось создать приглашение');
    const res = await botApi(env.BOT_TOKEN, 'savePreparedInlineMessage', {
      user_id: tgUser.id,
      result: {
        type: 'photo',
        id: `inv-${code}`,
        photo_url: `${url.origin}/invite.jpg`,
        thumbnail_url: `${url.origin}/invite-thumb.jpg`,
        photo_width: 941,
        photo_height: 1672,
        caption: inviteCaption(tgUser.firstName),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: inviteLink(env, refFor(tgUser.username, code), await hasMainApp(env, now)) }]] }
      },
      allow_user_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true
    });
    if (!res.ok) return error(502, 'prepare_failed', 'Telegram не принял приглашение');
    return json({ id: res.result.id, link: `${url.origin}/i/${code}` });
  }

  if (path === '/api/friends' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await addFriend(db, tgUser.id, body.code, now);
    if (res.error) return error(...res.error);
    if (res.added && res.friendId) await addNotice(db, res.friendId, 'friend_joined', `По твоей ссылке пришёл друг: ${tgUser.firstName || 'Игрок'}`, '#friends', now);
    return json({ added: res.added, name: res.name, self: res.self });
  }

  if (path === '/api/friends' && method === 'DELETE') {
    const code = url.searchParams.get('code') || '';
    if (!FRIEND_CODE.test(code)) return error(400, 'bad_code', 'Не тот код');
    const friend = await db.prepare('SELECT id FROM users WHERE friend_code = ?1').bind(code).first();
    if (friend) {
      await db.prepare('DELETE FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)')
        .bind(tgUser.id, friend.id).run();
    }
    return json({ removed: true });
  }

  if (path === '/api/predictions' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { matchId } = body;
    let { home, away } = body;
    // Прогноз только на исход: храним как условный счёт 1:0, 0:0 или 0:1 и kind = outcome.
    const kind = body.kind === 'outcome' ? 'outcome' : 'score';
    if (kind === 'outcome') {
      const OUT = { home: [1, 0], draw: [0, 0], away: [0, 1] };
      if (!Number.isInteger(matchId) || !OUT[body.pick]) return error(400, 'bad_prediction', 'Выбери П1, ничью или П2');
      [home, away] = OUT[body.pick];
    }
    const valid = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_GOALS;
    if (!Number.isInteger(matchId) || !valid(home) || !valid(away)) {
      return error(400, 'bad_prediction', 'Счёт должен быть от 0 до 15');
    }
    const match = await db.prepare('SELECT utc_date, status FROM matches WHERE id = ?1').bind(matchId).first();
    if (!match) return error(404, 'no_match', 'Матч не найден');
    const open = now < Date.parse(match.utc_date) - lockMs(env) && ['SCHEDULED', 'TIMED'].includes(match.status);
    if (!open) return error(409, 'locked', 'Приём прогнозов на этот матч закрыт');
    const at = nowIso(now);
    await db.prepare(`INSERT INTO predictions (user_id, match_id, home, away, kind, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?6, ?5, ?5)
      ON CONFLICT(user_id, match_id) DO UPDATE SET home = excluded.home, away = excluded.away, kind = excluded.kind, updated_at = excluded.updated_at
      WHERE predictions.settled_at IS NULL`).bind(tgUser.id, matchId, home, away, at, kind).run();
    return json({ saved: true, prediction: { matchId, home, away, kind } });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
    let rows;
    let me;
    if (period === 'all') {
      ({ results: rows } = await db.prepare(
        'SELECT id, first_name, photo_url, aura AS pts FROM users WHERE aura > 0 ORDER BY aura DESC, id LIMIT 50'
      ).all());
      const mine = await db.prepare('SELECT aura FROM users WHERE id = ?1').bind(tgUser.id).first();
      const above = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE aura > ?1').bind(mine.aura).first();
      me = { pts: mine.aura, rank: mine.aura > 0 ? above.n + 1 : null };
    } else {
      const weekStart = weekStartIso(now);
      ({ results: rows } = await db.prepare(
        `SELECT u.id, u.first_name, u.photo_url, SUM(p.points) AS pts
         FROM predictions p JOIN users u ON u.id = p.user_id
         WHERE p.settled_at >= ?1 GROUP BY u.id HAVING pts > 0
         ORDER BY pts DESC, u.id LIMIT 50`
      ).bind(weekStart).all());
      const mine = await db.prepare(
        'SELECT COALESCE(SUM(points), 0) AS pts FROM predictions WHERE user_id = ?1 AND settled_at >= ?2'
      ).bind(tgUser.id, weekStart).first();
      const above = await db.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT user_id, SUM(points) AS pts FROM predictions
         WHERE settled_at >= ?1 GROUP BY user_id HAVING pts > ?2)`
      ).bind(weekStart, mine.pts).first();
      me = { pts: mine.pts, rank: mine.pts > 0 ? above.n + 1 : null, weekStart };
    }
    return json({
      period,
      me,
      rows: rows.map((r, i) => ({ rank: i + 1, name: r.first_name || 'Игрок', photo: r.photo_url || null, pts: r.pts, isMe: r.id === tgUser.id }))
    });
  }

  return error(404, 'not_found', 'Нет такого адреса');
}

async function handleBot(request, env, url) {
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  // Игрок нажал «Поделиться номером» в приложении: Telegram присылает контакт боту.
  // Сохраняем, только если это его собственный номер и он уже зарегистрирован.
  if (msg && msg.contact && msg.from && msg.chat) {
    const own = msg.contact.user_id === msg.from.id;
    const phone = own ? normPhone(msg.contact.phone_number) : null;
    let saved = false;
    if (phone) {
      await ensureSchema(env.DB);
      const r = await env.DB.prepare('UPDATE users SET phone = ?1 WHERE id = ?2').bind(phone, msg.from.id).run();
      saved = Boolean(r.meta && r.meta.changes);
    }
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: saved ? '✅ Номер привязан. Теперь друзья найдут тебя в Точняке по номеру. Возвращайся в приложение.'
        : own ? 'Сначала зайди в приложение и прими правила, потом привяжи номер.' : 'Привязать можно только свой номер.',
      reply_markup: { remove_keyboard: true }
    });
    return new Response('ok');
  }
  if (!msg || !msg.text || !msg.chat) return new Response('ok');
  const appUrl = url.origin;
  const text = msg.text.trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    let inviter = null;
    let ref = null;
    if (payload && /^(f_[a-z0-9]{8}|[A-Za-z][A-Za-z0-9_]{3,31})$/.test(payload)) {
      await ensureSchema(env.DB);
      const row = await resolveRef(env.DB, payload);
      if (row) { inviter = row.first_name || 'Друг'; ref = [payload, row.friend_code]; }
    }
    const openUrl = ref && ref[1] ? `${appUrl}/?f=${ref[1]}` : appUrl;
    const keyboard = {
      inline_keyboard: [
        [{ text: ref ? '⚽ Присоединиться' : '⚽ Играть', web_app: { url: openUrl } }],
        [{ text: 'Правила и конфиденциальность', web_app: { url: `${appUrl}/#legal` } }]
      ]
    };
    const caption = welcomeCaption(inviter);
    const photo = await botApi(env.BOT_TOKEN, 'sendPhoto', {
      chat_id: msg.chat.id, photo: `${appUrl}/invite.jpg`, caption, parse_mode: 'HTML', reply_markup: keyboard
    });
    // Если Telegram не смог забрать картинку, отправляем тот же текст без неё.
    if (!photo || !photo.ok) {
      await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, text: caption, parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else if (text.startsWith('/privacy')) {
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Правила игры и политика конфиденциальности открываются прямо в приложении.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть', web_app: { url: `${appUrl}/#privacy` } }]] }
    });
  } else if (text.startsWith('/admin')) {
    // Разовая привязка: разработчик пишет боту «/admin <WEBHOOK_SECRET>», и сюда начнут приходить обращения игроков.
    const key = text.split(/\s+/)[1] || '';
    if (env.WEBHOOK_SECRET && key === env.WEBHOOK_SECRET) {
      await ensureSchema(env.DB);
      await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('admin_chat', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(msg.chat.id)).run();
      await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, text: 'Готово: обращения игроков будут приходить сюда.' });
    }
  } else if (text.startsWith('/help')) {
    await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, text: 'Напиши вопрос или идею одним сообщением прямо сюда, ответим в этом чате.' });
  } else if (text.startsWith('/mute') || text.startsWith('/unmute')) {
    // Напоминания о матчах и итоги недели: выключить или включить обратно.
    const on = text.startsWith('/unmute');
    await ensureSchema(env.DB);
    await env.DB.prepare('UPDATE users SET notify = ?1 WHERE id = ?2').bind(on ? 1 : 0, msg.chat.id).run();
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: on ? 'Готово, напоминания о матчах и итоги недели снова включены.'
        : 'Готово, напоминания и итоги недели больше не придут. Включить обратно: /unmute'
    });
  } else if (!text.startsWith('/')) {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'admin_chat'").first();
    const admin = row ? JSON.parse(row.value) : null;
    // Разработчик отвечает на пересланное обращение (Ответить) — бот отправляет ответ игроку.
    if (admin && admin === msg.chat.id) {
      const replyTo = msg.reply_to_message && msg.reply_to_message.message_id;
      const target = replyTo
        ? await env.DB.prepare('SELECT user_chat_id FROM support_map WHERE admin_msg_id = ?1').bind(replyTo).first()
        : null;
      if (!target) {
        await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: admin, text: 'Чтобы ответить игроку, нажми «Ответить» на его пересланном сообщении.' });
        return new Response('ok');
      }
      const sent = await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: target.user_chat_id, text: `💬 Ответ поддержки Точняка:\n\n${text}` });
      await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: admin, text: sent && sent.ok ? '✅ Ответ отправлен.' : 'Не получилось отправить: возможно, игрок остановил бота.' });
      return new Response('ok');
    }
    // Обычное сообщение боту — обращение в поддержку. Пересылаем разработчику и запоминаем, кому отвечать.
    let forwarded = false;
    if (admin) {
      const fw = await botApi(env.BOT_TOKEN, 'forwardMessage', { chat_id: admin, from_chat_id: msg.chat.id, message_id: msg.message_id });
      if (fw && fw.ok && fw.result) {
        forwarded = true;
        await env.DB.prepare('INSERT OR REPLACE INTO support_map (admin_msg_id, user_chat_id, created_at) VALUES (?1, ?2, ?3)')
          .bind(fw.result.message_id, msg.chat.id, nowIso()).run();
      }
    }
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: forwarded ? 'Сообщение получили, ответим здесь же в течение пары дней.' : 'Спасибо! Поддержка пока не подключена, попробуй написать чуть позже.'
    });
  } else if (text.startsWith('/delete')) {
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Удалить аккаунт и все данные можно в приложении: Профиль → «Удалить аккаунт».',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть профиль', web_app: { url: `${appUrl}/#profile` } }]] }
    });
  }
  return new Response('ok');
}

// Страница-ссылка приглашения: в Telegram разворачивается в большую картинку, а при открытии ведёт в бота.
async function handleInvitePage(env, url) {
  const m = /^\/i\/([a-z0-9]{8})$/.exec(url.pathname);
  const target = m ? inviteLink(env, `f_${m[1]}`, await hasMainApp(env)) : `https://t.me/${botUsername(env)}`;
  const t = escHtml(target);
  const img = `${url.origin}/invite.jpg`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Точняк: приглашение от друга</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Точняк">
<meta property="og:title" content="Тебя позвали в Точняк 🎯">
<meta property="og:description" content="Угадывай победителей и точный счёт матчей топ-лиг, обгоняй друзей. Бесплатно и без ставок.">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="941">
<meta property="og:image:height" content="1672">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${t}">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#02060E;color:#F5F2F4;font:600 16px system-ui,sans-serif}a{color:#FF2E63}</style>
</head><body><a href="${t}">Открыть Точняк в Telegram</a></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

// Эмблемы клубов: берём у football-data.org и кэшируем на неделю.
const CREST_TYPES = { png: 'image/png', svg: 'image/svg+xml', gif: 'image/gif' };
async function handleCrest(url) {
  const m = /^\/crest\/([A-Za-z0-9_-]{1,40})\.(png|svg|gif)$/.exec(url.pathname);
  if (!m) return new Response('not found', { status: 404 });
  const upstream = await fetch(`https://crests.football-data.org/${m[1]}.${m[2]}`, {
    cf: { cacheEverything: true, cacheTtl: 604800 }
  });
  if (!upstream.ok) return new Response('not found', { status: 404 });
  return new Response(upstream.body, {
    headers: {
      'content-type': CREST_TYPES[m[2]],
      'cache-control': 'public, max-age=604800, immutable',
      // Картинка показывается только внутри <img>. Если открыть адрес напрямую, браузер её скачает,
      // а не выполнит: так чужой SVG не сможет запустить скрипт на нашем домене.
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff'
    }
  });
}

// Разовая настройка бота: открой https://<адрес-воркера>/setup?key=<WEBHOOK_SECRET> в браузере.
async function handleSetup(env, url, now) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const origin = url.origin;
  const results = {};
  results.webhook = await botApi(env.BOT_TOKEN, 'setWebhook', {
    url: `${origin}/bot/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: true
  });
  results.menu = await botApi(env.BOT_TOKEN, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Играть', web_app: { url: origin } }
  });
  results.commands = await botApi(env.BOT_TOKEN, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть Точняк' },
      { command: 'privacy', description: 'Политика конфиденциальности' },
      { command: 'delete', description: 'Как удалить аккаунт и данные' },
      { command: 'help', description: 'Написать в поддержку' },
      { command: 'mute', description: 'Выключить напоминания' },
      { command: 'unmute', description: 'Включить напоминания' }
    ]
  });
  results.sync = await syncAndSettle(env, now);
  const ok = results.webhook.ok && results.menu.ok && results.commands.ok;
  return json({ ok, results: { webhook: results.webhook.ok, menu: results.menu.ok, commands: results.commands.ok, sync: results.sync } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const now = Date.now();
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/bot/webhook' || url.pathname === '/setup' || url.pathname === '/health') {
        await ensureSchema(env.DB);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, now, ctx);
      if (url.pathname.startsWith('/crest/')) return await handleCrest(url);
      if (url.pathname.startsWith('/i/')) return handleInvitePage(env, url);
      // Правила и политика теперь внутри приложения. Старые ссылки ведут туда же.
      if (url.pathname === '/privacy.html' || url.pathname === '/privacy') return Response.redirect(`${url.origin}/#privacy`, 302);
      if (url.pathname === '/terms.html' || url.pathname === '/terms') return Response.redirect(`${url.origin}/#terms`, 302);
      if (url.pathname === '/bot/webhook' && request.method === 'POST') return await handleBot(request, env, url);
      if (url.pathname === '/setup') return await handleSetup(env, url, now);
      if (url.pathname === '/health') {
        const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_sync'").first();
        return json({ ok: true, lastSync: row ? JSON.parse(row.value) : null });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return error(500, 'server_error', 'Что-то пошло не так. Попробуйте ещё раз');
    }
  },

  async scheduled(event, env, ctx) {
    // Сначала матчи и аура, потом сообщения бота. Ошибка синхронизации не отменяет напоминания.
    ctx.waitUntil(ensureSchema(env.DB)
      .then(() => syncAndSettle(env))
      .catch((err) => console.error('sync', err))
      .then(() => runBotJobs(env)));
  }
};
