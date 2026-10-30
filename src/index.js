// Точняк: Cloudflare Worker. Раздаёт мини-апп (папка public), отвечает на API,
// принимает сообщения бота и раз в 10 минут обновляет матчи.

import { ensureSchema, nowIso, newFriendCode } from './db.js';
import { validateInitData, botApi } from './telegram.js';
import { syncAndSettle } from './footballData.js';

const MAX_GOALS = 15;
const MAX_FRIENDS = 300;
const FRIEND_CODE = /^[a-z0-9]{8}$/;
const MSK_OFFSET = 3 * 3600000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const error = (status, code, message) => json({ error: code, message }, status);

// Начало недели рейтинга: понедельник 00:00 по Москве.
export function weekStartIso(now = Date.now()) {
  const msk = new Date(now + MSK_OFFSET);
  const dayFromMonday = (msk.getUTCDay() + 6) % 7;
  const mondayMsk = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - dayFromMonday);
  return new Date(mondayMsk - MSK_OFFSET).toISOString();
}

function lockMs(env) {
  return Number(env.LOCK_MINUTES || 5) * 60000;
}

function botUsername(env) {
  return env.BOT_USERNAME || 'tochnyak_bot';
}

function inviteLink(env, code) {
  return `https://t.me/${botUsername(env)}?start=f_${code}`;
}

const crestUrl = (file) => (file ? `/crest/${file}` : null);

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
    home: { name: m.home_name, short: m.home_short, tla: m.home_tla, crest: crestUrl(m.home_crest) },
    away: { name: m.away_name, short: m.away_short, tla: m.away_tla, crest: crestUrl(m.away_crest) },
    score: m.home_score == null ? null : { home: m.home_score, away: m.away_score },
    prediction: m.pred_home == null ? null : { home: m.pred_home, away: m.pred_away, points: m.pred_points }
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

async function addFriend(db, userId, code, now) {
  if (!FRIEND_CODE.test(String(code || ''))) return { error: [400, 'bad_code', 'Ссылка-приглашение не подходит'] };
  const friend = await db.prepare('SELECT id, first_name FROM users WHERE friend_code = ?1').bind(code).first();
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
  return { added, name: friend.first_name || 'Игрок' };
}

async function currentTelegramUser(request, env) {
  const initData = request.headers.get('x-telegram-init-data');
  return validateInitData(initData, env.BOT_TOKEN);
}

async function loadProfile(db, userId, now) {
  const user = await db.prepare('SELECT id, first_name, aura, created_at FROM users WHERE id = ?1').bind(userId).first();
  if (!user) return null;
  const weekStart = weekStartIso(now);
  const week = await db.prepare(
    'SELECT COALESCE(SUM(points), 0) AS pts, COUNT(*) AS n FROM predictions WHERE user_id = ?1 AND settled_at >= ?2'
  ).bind(userId, weekStart).first();
  const totals = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN points >= 10 THEN 1 ELSE 0 END) AS exact
     FROM predictions WHERE user_id = ?1 AND settled_at IS NOT NULL`
  ).bind(userId).first();
  return {
    id: user.id,
    firstName: user.first_name,
    aura: user.aura,
    weekAura: week.pts,
    settledPredictions: totals.total || 0,
    exactHits: totals.exact || 0,
    joinedAt: user.created_at,
    friendCode: await ensureFriendCode(db, userId),
    friendsCount: (await db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?1').bind(userId).first()).n
  };
}

async function handleApi(request, env, url, now) {
  const db = env.DB;
  const tgUser = await currentTelegramUser(request, env);
  if (!tgUser) return error(401, 'unauthorized', 'Откройте приложение через Telegram');

  const path = url.pathname;
  const method = request.method;

  if (path === '/api/me' && method === 'GET') {
    const profile = await loadProfile(db, tgUser.id, now);
    if (!profile) return json({ registered: false, firstName: tgUser.firstName });
    await db.prepare('UPDATE users SET last_seen_at = ?1, first_name = ?2, username = ?3, language_code = ?4 WHERE id = ?5')
      .bind(nowIso(now), tgUser.firstName, tgUser.username, tgUser.languageCode, tgUser.id).run();
    return json({ registered: true, profile });
  }

  if (path === '/api/auth' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.accept !== true) return error(400, 'consent_required', 'Нужно согласие с правилами и политикой конфиденциальности');
    const at = nowIso(now);
    await db.prepare(`INSERT INTO users (id, first_name, username, language_code, aura, accepted_terms_at, created_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?5)
      ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
        language_code = excluded.language_code, last_seen_at = excluded.last_seen_at`)
      .bind(tgUser.id, tgUser.firstName, tgUser.username, tgUser.languageCode, at).run();
    return json({ registered: true, profile: await loadProfile(db, tgUser.id, now) });
  }

  // Дальше только для зарегистрированных.
  const exists = await db.prepare('SELECT 1 AS ok FROM users WHERE id = ?1').bind(tgUser.id).first();
  if (!exists) return error(403, 'not_registered', 'Сначала войдите в приложение');

  if (path === '/api/me' && method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM predictions WHERE user_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1').bind(tgUser.id),
      db.prepare('DELETE FROM users WHERE id = ?1').bind(tgUser.id)
    ]);
    return json({ deleted: true });
  }

  if (path === '/api/matches' && method === 'GET') {
    const from = new Date(now - 2 * 86400000).toISOString();
    const to = new Date(now + 8 * 86400000).toISOString();
    const { results } = await db.prepare(
      `SELECT m.*, p.home AS pred_home, p.away AS pred_away, p.points AS pred_points
       FROM matches m LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?1
       WHERE m.utc_date BETWEEN ?2 AND ?3 AND m.status NOT IN ('CANCELLED')
       ORDER BY m.utc_date, m.id`
    ).bind(tgUser.id, from, to).all();
    return json({ matches: results.map((m) => matchOut(m, env, now)), now: nowIso(now) });
  }

  // Мои прогнозы: будущие и сыгранные, свежие сверху.
  if (path === '/api/my' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT m.*, p.home AS pred_home, p.away AS pred_away, p.points AS pred_points
       FROM predictions p JOIN matches m ON m.id = p.match_id
       WHERE p.user_id = ?1 ORDER BY m.utc_date DESC, m.id DESC LIMIT 100`
    ).bind(tgUser.id).all();
    return json({ items: results.map((m) => matchOut(m, env, now)) });
  }

  if (path === '/api/friends' && method === 'GET') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
    const code = await ensureFriendCode(db, tgUser.id);
    const circle = 'u.id = ?1 OR u.id IN (SELECT friend_id FROM friends WHERE user_id = ?1)';
    const { results } = period === 'all'
      ? await db.prepare(`SELECT u.id, u.first_name, u.friend_code, u.aura AS pts FROM users u
          WHERE ${circle} ORDER BY pts DESC, u.id`).bind(tgUser.id).all()
      : await db.prepare(`SELECT u.id, u.first_name, u.friend_code, COALESCE(SUM(p.points), 0) AS pts FROM users u
          LEFT JOIN predictions p ON p.user_id = u.id AND p.settled_at >= ?2
          WHERE ${circle} GROUP BY u.id ORDER BY pts DESC, u.id`).bind(tgUser.id, weekStartIso(now)).all();
    return json({
      period,
      code,
      link: code ? inviteLink(env, code) : null,
      rows: results.map((r, i) => ({
        rank: i + 1,
        name: r.first_name || 'Игрок',
        pts: r.pts,
        isMe: r.id === tgUser.id,
        code: r.id === tgUser.id ? null : r.friend_code
      }))
    });
  }

  if (path === '/api/friends' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const res = await addFriend(db, tgUser.id, body.code, now);
    if (res.error) return error(...res.error);
    return json(res);
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
    const { matchId, home, away } = body;
    const valid = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_GOALS;
    if (!Number.isInteger(matchId) || !valid(home) || !valid(away)) {
      return error(400, 'bad_prediction', 'Счёт должен быть от 0 до 15');
    }
    const match = await db.prepare('SELECT utc_date, status FROM matches WHERE id = ?1').bind(matchId).first();
    if (!match) return error(404, 'no_match', 'Матч не найден');
    const open = now < Date.parse(match.utc_date) - lockMs(env) && ['SCHEDULED', 'TIMED'].includes(match.status);
    if (!open) return error(409, 'locked', 'Приём прогнозов на этот матч закрыт');
    const at = nowIso(now);
    await db.prepare(`INSERT INTO predictions (user_id, match_id, home, away, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(user_id, match_id) DO UPDATE SET home = excluded.home, away = excluded.away, updated_at = excluded.updated_at
      WHERE predictions.settled_at IS NULL`).bind(tgUser.id, matchId, home, away, at).run();
    return json({ saved: true, prediction: { matchId, home, away } });
  }

  if (path === '/api/leaderboard' && method === 'GET') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
    let rows;
    let me;
    if (period === 'all') {
      ({ results: rows } = await db.prepare(
        'SELECT id, first_name, aura AS pts FROM users WHERE aura > 0 ORDER BY aura DESC, id LIMIT 50'
      ).all());
      const mine = await db.prepare('SELECT aura FROM users WHERE id = ?1').bind(tgUser.id).first();
      const above = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE aura > ?1').bind(mine.aura).first();
      me = { pts: mine.aura, rank: mine.aura > 0 ? above.n + 1 : null };
    } else {
      const weekStart = weekStartIso(now);
      ({ results: rows } = await db.prepare(
        `SELECT u.id, u.first_name, SUM(p.points) AS pts
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
      rows: rows.map((r, i) => ({ rank: i + 1, name: r.first_name || 'Игрок', pts: r.pts, isMe: r.id === tgUser.id }))
    });
  }

  return error(404, 'not_found', 'Нет такого адреса');
}

async function handleBot(request, env, url) {
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.text || !msg.chat) return new Response('ok');
  const appUrl = url.origin;
  const text = msg.text.trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    const ref = /^f_([a-z0-9]{8})$/.exec(payload);
    const openUrl = ref ? `${appUrl}/?f=${ref[1]}` : appUrl;
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: ref
        ? 'Тебя позвали в Точняк. Угадывай счёт матчей и обгоняй друзей. Без ставок и денег.'
        : 'Угадывай счёт матчей топ-лиг, копи ауру и обгоняй друзей. Без ставок и денег.',
      reply_markup: {
        inline_keyboard: [
          [{ text: ref ? 'Играть с другом' : 'Открыть Точняк', web_app: { url: openUrl } }],
          [{ text: 'Политика конфиденциальности', url: `${appUrl}/privacy.html` }, { text: 'Правила', url: `${appUrl}/terms.html` }]
        ]
      }
    });
  } else if (text.startsWith('/privacy')) {
    await botApi(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, text: `Политика конфиденциальности: ${appUrl}/privacy.html` });
  } else if (text.startsWith('/delete')) {
    await botApi(env.BOT_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: 'Удалить аккаунт и все данные можно в приложении: Профиль → «Удалить аккаунт и данные».',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть профиль', web_app: { url: `${appUrl}/#profile` } }]] }
    });
  }
  return new Response('ok');
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
      // SVG с чужого сервера: запрещаем в нём скрипты и любые загрузки.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
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
      { command: 'delete', description: 'Как удалить аккаунт и данные' }
    ]
  });
  results.sync = await syncAndSettle(env, now);
  const ok = results.webhook.ok && results.menu.ok && results.commands.ok;
  return json({ ok, results: { webhook: results.webhook.ok, menu: results.menu.ok, commands: results.commands.ok, sync: results.sync } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/bot/webhook' || url.pathname === '/setup' || url.pathname === '/health') {
        await ensureSchema(env.DB);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url, now);
      if (url.pathname.startsWith('/crest/')) return await handleCrest(url);
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
    ctx.waitUntil(ensureSchema(env.DB).then(() => syncAndSettle(env)));
  }
};
