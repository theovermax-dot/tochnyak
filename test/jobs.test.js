import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureSchema, resetSchemaFlag } from '../src/db.js';
import { sendReminders, weeklyWrapUp } from '../src/jobs.js';
import { TestD1 } from './helpers.js';

const MIN = 60000;

async function makeEnv() {
  resetSchemaFlag();
  const env = { DB: new TestD1(), BOT_TOKEN: 'test-token' };
  await ensureSchema(env.DB);
  return env;
}

async function addUser(env, id, name, at) {
  await env.DB.prepare(`INSERT INTO users (id, first_name, aura, accepted_terms_at, created_at, last_seen_at, reg_version)
    VALUES (?1, ?2, 0, ?3, ?3, ?3, 2)`).bind(id, name, at).run();
}

async function addMatch(env, id, utcDate, status = 'TIMED') {
  await env.DB.prepare(`INSERT INTO matches (id, competition, competition_name, utc_date, status, home_name, home_short, home_tla,
    away_name, away_short, away_tla, updated_at) VALUES (?1, 'BL1', 'Bundesliga', ?2, ?3, 'FC Schalke 04', 'Schalke', 'S04',
    'RB Leipzig', 'RB Leipzig', 'RBL', ?2)`).bind(id, utcDate, status).run();
}

async function addPrediction(env, userId, matchId, at, points = null, settledAt = null) {
  await env.DB.prepare(`INSERT INTO predictions (user_id, match_id, home, away, points, settled_at, created_at, updated_at)
    VALUES (?1, ?2, 1, 0, ?3, ?4, ?5, ?5)`).bind(userId, matchId, points, settledAt, at).run();
}

function fakeBot(fail = {}) {
  const sent = [];
  const send = async (_token, method, payload) => {
    sent.push({ method, ...payload });
    return fail[payload.chat_id] ? { ok: false, error_code: fail[payload.chat_id] } : { ok: true, result: {} };
  };
  return { sent, send };
}

test('напоминание: только тем, у кого нет прогноза, один раз на матч, /mute и блок бота учитываются', async () => {
  const env = await makeEnv();
  const now = Date.parse('2026-10-31T12:00:00Z');
  const at = new Date(now - 86400000).toISOString();
  for (const [id, name] of [[1, 'Макс'], [2, 'Витя'], [3, 'Тихий'], [4, 'Ушёл'], [5, 'Блок']]) await addUser(env, id, name, at);
  // Приём закрывается через 55 минут: матч начинается через 60 (замок 5 минут).
  await addMatch(env, 100, new Date(now + 60 * MIN).toISOString());
  // Старый матч, чтобы все были «активными» игроками.
  await addMatch(env, 50, new Date(now - 2 * 86400000).toISOString(), 'FINISHED');
  for (const id of [1, 2, 3, 5]) await addPrediction(env, id, 50, at);
  await addPrediction(env, 2, 100, at); // Витя уже поставил
  await env.DB.prepare('UPDATE users SET notify = 0 WHERE id = 3').run(); // Тихий выключил /mute

  const bot = fakeBot({ 5: 403 });
  const n = await sendReminders(env, { now, lockMs: 5 * MIN, appUrl: 'https://app.test', send: bot.send });
  assert.equal(n, 1);
  assert.deepEqual(bot.sent.map((m) => m.chat_id).sort(), [1, 5]);
  const toMax = bot.sent.find((m) => m.chat_id === 1);
  assert.match(toMax.text, /Через час закрывается приём/);
  assert.match(toMax.text, /Schalke 04 — RB Leipzig/);
  assert.equal(toMax.reply_markup.inline_keyboard[0][0].web_app.url, 'https://app.test');
  // Заблокировал бота — больше не пишем.
  assert.equal((await env.DB.prepare('SELECT notify FROM users WHERE id = 5').first()).notify, 0);

  // Повторный запуск через 10 минут: этот матч уже напомнен.
  const again = fakeBot();
  assert.equal(await sendReminders(env, { now: now + 10 * MIN, lockMs: 5 * MIN, appUrl: 'https://app.test', send: again.send }), 0);
  assert.equal(again.sent.length, 0);
});

test('итоги недели: +10 монет лидерам, уведомление, один раз и только в первые сутки', async () => {
  const env = await makeEnv();
  // Понедельник 2 ноября 2026, 01:00 по Москве.
  const now = Date.parse('2026-11-01T22:00:00Z');
  const lastWeek = '2026-10-30T20:00:00.000Z';
  const at = '2026-10-20T10:00:00.000Z';
  for (const [id, name] of [[1, 'Макс'], [2, 'Витя'], [3, 'Артём']]) await addUser(env, id, name, at);
  for (const id of [1, 2, 3]) await addMatch(env, id, lastWeek, 'FINISHED');
  await addPrediction(env, 1, 1, at, 12, lastWeek);
  await addPrediction(env, 2, 1, at, 12, lastWeek);
  await addPrediction(env, 3, 1, at, 3, lastWeek);
  // Очки, начисленные уже в новую неделю, в итоги прошлой не идут.
  await addPrediction(env, 3, 2, at, 20, '2026-11-01T21:30:00.000Z');

  const bot = fakeBot();
  const res = await weeklyWrapUp(env, { now, appUrl: 'https://app.test/#rating', send: bot.send });
  assert.deepEqual(res.winners, [1, 2]);
  assert.equal(res.players, 3);
  const coins = await env.DB.prepare('SELECT id, coins FROM users ORDER BY id').all();
  assert.deepEqual(coins.results.map((r) => r.coins), [10, 10, 0]);
  const notes = await env.DB.prepare("SELECT user_id FROM notifications WHERE kind = 'week_winner' ORDER BY user_id").all();
  assert.deepEqual(notes.results.map((r) => r.user_id), [1, 2]);
  assert.equal(bot.sent.length, 3);
  assert.match(bot.sent.find((m) => m.chat_id === 1).text, /Ты лучший на неделе/);
  assert.match(bot.sent.find((m) => m.chat_id === 3).text, /Ты на 3 месте из 3, аура за неделю: 3/);

  // Второй запуск в тот же день ничего не делает.
  assert.equal(await weeklyWrapUp(env, { now: now + 10 * MIN, appUrl: 'https://app.test/#rating', send: bot.send }), null);
  assert.equal((await env.DB.prepare('SELECT coins FROM users WHERE id = 1').first()).coins, 10);
  // Во вторник итоги уже не подводятся (например, сразу после деплоя посреди недели).
  const env2 = await makeEnv();
  assert.equal(await weeklyWrapUp(env2, { now: now + 2 * 86400000, appUrl: 'x', send: bot.send }), null);
});
