// Фоновые задачи бота: напоминание «через час закрывается приём» и итоги недели.
// Запускаются из расписания раз в 10 минут, после синхронизации матчей.
// Пишем только тем, кто не отключил сообщения командой /mute (users.notify = 1).

import { nowIso } from './db.js';
import { botApi } from './telegram.js';
import { COINS } from './scoring.js';
import { teamName } from './teams.js';
import { weekStartIso } from './week.js';

const MIN = 60000;
const DAY = 86400000;
const MAX_MESSAGES = 300; // за один запуск, чтобы не упереться в лимиты Telegram и воркера

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const button = (url, text) => ({ inline_keyboard: [[{ text, web_app: { url } }]] });

// Отправка одному игроку. Если он остановил бота (403), больше ему не пишем.
async function deliver(env, send, chatId, payload) {
  let res = null;
  try {
    res = await send(env.BOT_TOKEN, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', ...payload });
  } catch {
    return false;
  }
  if (res && res.ok) return true;
  if (res && res.error_code === 403) await env.DB.prepare('UPDATE users SET notify = 0 WHERE id = ?1').bind(chatId).run();
  return false;
}

// Матчи, у которых приём закрывается через 50–60 минут (расписание идёт шагом 10 минут).
// Напоминаем активным игрокам (делали прогноз за последние 14 дней), у кого на эти матчи прогноза нет.
export async function sendReminders(env, { now = Date.now(), lockMs = 5 * MIN, appUrl, send = botApi } = {}) {
  if (!env.BOT_TOKEN || !appUrl) return 0;
  const db = env.DB;
  const from = new Date(now + 50 * MIN + lockMs).toISOString();
  const to = new Date(now + 60 * MIN + lockMs).toISOString();
  const { results: matches } = await db.prepare(
    `SELECT id, home_short, home_name, away_short, away_name FROM matches
     WHERE utc_date > ?1 AND utc_date <= ?2 AND status IN ('SCHEDULED', 'TIMED')
       AND id NOT IN (SELECT match_id FROM reminders_sent)
     ORDER BY utc_date, id`
  ).bind(from, to).all();
  if (!matches.length) return 0;

  // Сначала отмечаем матчи, чтобы следующий запуск не напомнил ещё раз.
  const at = nowIso(now);
  await db.batch(matches.map((m) => db.prepare('INSERT OR IGNORE INTO reminders_sent (match_id, sent_at) VALUES (?1, ?2)').bind(m.id, at)));

  const ids = matches.map((m) => m.id);
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results: preds } = await db.prepare(`SELECT user_id, match_id FROM predictions WHERE match_id IN (${marks})`).bind(...ids).all();
  const has = new Set(preds.map((p) => `${p.user_id}:${p.match_id}`));
  const { results: users } = await db.prepare(
    `SELECT u.id FROM users u WHERE u.notify = 1
       AND EXISTS (SELECT 1 FROM predictions p WHERE p.user_id = u.id AND p.updated_at >= ?1)
     ORDER BY u.last_seen_at DESC LIMIT ${MAX_MESSAGES}`
  ).bind(nowIso(now - 14 * DAY)).all();

  let sent = 0;
  for (const u of users) {
    const missing = matches.filter((m) => !has.has(`${u.id}:${m.id}`));
    if (!missing.length) continue;
    const list = missing.slice(0, 5)
      .map((m) => `• ${esc(teamName(m.home_short, m.home_name))} — ${esc(teamName(m.away_short, m.away_name))}`).join('\n');
    const more = missing.length > 5 ? `\nи ещё ${missing.length - 5}` : '';
    const ok = await deliver(env, send, u.id, {
      text: `⏰ <b>Через час закрывается приём прогнозов</b>\n\n${list}${more}\n\nОтключить напоминания: /mute`,
      reply_markup: button(appUrl, 'Сделать прогноз')
    });
    if (ok) sent += 1;
  }
  return sent;
}

// Итоги прошлой недели: +10 монет лидеру (при равенстве — всем лидерам), уведомление в приложении
// и сообщение в бота каждому, кто играл. Только в первые сутки новой недели и только один раз.
export async function weeklyWrapUp(env, { now = Date.now(), appUrl, send = botApi } = {}) {
  const db = env.DB;
  const weekStart = weekStartIso(now);
  if (now - Date.parse(weekStart) > DAY) return null;
  const claim = await db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING')
    .bind(`week_done:${weekStart}`, JSON.stringify({ at: nowIso(now) })).run();
  if (!claim.meta || !claim.meta.changes) return null;

  const prevStart = weekStartIso(Date.parse(weekStart) - 1);
  const { results: rows } = await db.prepare(
    `SELECT u.id, u.first_name, u.notify, COALESCE(SUM(p.points), 0) AS pts
     FROM predictions p JOIN users u ON u.id = p.user_id
     WHERE p.settled_at >= ?1 AND p.settled_at < ?2
     GROUP BY u.id ORDER BY pts DESC, u.id`
  ).bind(prevStart, weekStart).all();
  if (!rows.length) return { players: 0, winners: [], sent: 0 };

  const top = rows[0].pts;
  const winners = top > 0 ? rows.filter((r) => r.pts === top) : [];
  const at = nowIso(now);
  if (winners.length) {
    await db.batch(winners.flatMap((w) => [
      db.prepare('UPDATE users SET coins = coins + ?1 WHERE id = ?2').bind(COINS.weekWinner, w.id),
      db.prepare('INSERT INTO notifications (user_id, kind, text, link, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(w.id, 'week_winner', `Ты первый за неделю: ${w.pts} ауры. +${COINS.weekWinner} монет`, '#rating', at)
    ]));
  }

  let sent = 0;
  if (env.BOT_TOKEN && appUrl) {
    const leader = winners.slice(0, 3).map((w) => w.first_name || 'Игрок').join(', ');
    for (const r of rows.filter((x) => x.notify).slice(0, MAX_MESSAGES)) {
      const place = 1 + rows.filter((x) => x.pts > r.pts).length;
      const isWinner = winners.some((w) => w.id === r.id);
      const head = isWinner
        ? `🏆 <b>Ты лучший на неделе!</b>\n\nАура за неделю: ${r.pts}. За первое место +${COINS.weekWinner} монет.`
        : `📊 <b>Итоги недели</b>\n\nТы на ${place} месте из ${rows.length}, аура за неделю: ${r.pts}.${leader ? `\nПервое место: ${esc(leader)} (${top}).` : ''}`;
      const ok = await deliver(env, send, r.id, {
        text: `${head}\n\nНовая неделя уже началась, рейтинг недели с нуля.\n\nОтключить такие сообщения: /mute`,
        reply_markup: button(appUrl, 'Открыть рейтинг')
      });
      if (ok) sent += 1;
    }
  }
  return { players: rows.length, winners: winners.map((w) => w.id), sent };
}

// ---------- Топ-матч дня: раз в день в 10:00 по Москве ----------

const MSK = 3 * 3600000;
const LEAGUE_WEIGHT = { CL: 100, PL: 90, PD: 85, SA: 75, BL1: 72, FL1: 62, DED: 55 };
const LEAGUE_NAME = { CL: 'Лига чемпионов', PL: 'АПЛ', PD: 'Ла Лига', SA: 'Серия А', BL1: 'Бундеслига', FL1: 'Лига 1', DED: 'Эредивизи' };
const BIG_CLUB = /Real Madrid|Barcelona|Atl[ée]tico|Manchester City|Manchester United|Arsenal|Liverpool|Chelsea|Tottenham|Newcastle|Bayern|Dortmund|Leverkusen|Internazionale|Milan|Juventus|Napoli|Roma|Paris Saint|Marseille|Ajax|PSV|Feyenoord|Benfica|Porto|Sporting/i;

// Чем громче матч, тем больше балл: лига + большие клубы, а встреча двух грандов — особенно.
export function topMatchScore(m) {
  const big = [m.home_name, m.away_name].filter((n) => BIG_CLUB.test(n || '')).length;
  return (LEAGUE_WEIGHT[m.competition] || 40) + big * 30 + (big === 2 ? 40 : 0);
}

const mskDay = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const mskTime = (iso) => new Date(Date.parse(iso) + MSK).toISOString().slice(11, 16);

export async function dailyTopMatch(env, { now = Date.now(), lockMs = 5 * MIN, appUrl, send = botApi } = {}) {
  const hour = new Date(now + MSK).getUTCHours();
  if (hour !== 10) return null;
  const db = env.DB;
  const day = mskDay(now);
  const dayStart = Date.parse(`${day}T00:00:00Z`) - MSK;
  const { results: matches } = await db.prepare(
    `SELECT id, competition, utc_date, home_short, home_name, away_short, away_name FROM matches
     WHERE utc_date > ?1 AND utc_date < ?2 AND status IN ('SCHEDULED', 'TIMED')`
  ).bind(new Date(now + lockMs).toISOString(), new Date(dayStart + DAY).toISOString()).all();
  if (!matches.length) return null;
  // Один раз в день, даже если расписание сработает дважды.
  const claim = await db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING')
    .bind(`top_day:${day}`, JSON.stringify({ at: nowIso(now) })).run();
  if (!claim.meta || !claim.meta.changes) return null;

  const top = matches.slice().sort((a, b) => topMatchScore(b) - topMatchScore(a) || a.utc_date.localeCompare(b.utc_date) || a.id - b.id)[0];
  if (!env.BOT_TOKEN || !appUrl) return { match: top.id, sent: 0 };
  // Игрокам, кто заходил последние 30 дней и ещё не сделал прогноз на этот матч.
  const { results: users } = await db.prepare(
    `SELECT u.id FROM users u WHERE u.notify = 1 AND u.last_seen_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.user_id = u.id AND p.match_id = ?2)
     ORDER BY u.last_seen_at DESC LIMIT ${MAX_MESSAGES}`
  ).bind(nowIso(now - 30 * DAY), top.id).all();
  const home = esc(teamName(top.home_short, top.home_name));
  const away = esc(teamName(top.away_short, top.away_name));
  const text = `🔥 <b>Топ-матч дня</b>\n\n<b>${home} — ${away}</b>\n${esc(LEAGUE_NAME[top.competition] || '')} · сегодня в ${mskTime(top.utc_date)} МСК\n\nКто победит? Прогноз принимается до начала матча.\n\nОтключить сообщения: /mute`;
  let sent = 0;
  for (const u of users) {
    if (await deliver(env, send, u.id, { text, reply_markup: button(`${appUrl}/#match-${top.id}`, 'Сделать прогноз') })) sent += 1;
  }
  return { match: top.id, sent };
}

export async function runBotJobs(env, now = Date.now()) {
  const appUrl = env.APP_URL || null;
  const lockMs = Number(env.LOCK_MINUTES || 5) * MIN;
  const out = {};
  try { out.top = await dailyTopMatch(env, { now, lockMs, appUrl }); } catch (err) { console.error('top', err); }
  try { out.reminders = await sendReminders(env, { now, lockMs, appUrl }); } catch (err) { console.error('reminders', err); }
  try { out.week = await weeklyWrapUp(env, { now, appUrl: appUrl && `${appUrl}/#rating` }); } catch (err) { console.error('week', err); }
  return out;
}
