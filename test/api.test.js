import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { weekStartIso } from '../src/index.js';
import { resetSchemaFlag } from '../src/db.js';
import { upsertMatches, settleFinished } from '../src/footballData.js';
import { TestD1, signInitData } from './helpers.js';

const TOKEN = '123456:TEST_TOKEN_FOR_TESTS_ONLY';

function makeEnv() {
  resetSchemaFlag();
  return {
    DB: new TestD1(),
    BOT_TOKEN: TOKEN,
    WEBHOOK_SECRET: 'test-secret',
    COMPETITIONS: 'PL',
    LOCK_MINUTES: '5',
    ASSETS: { fetch: async () => new Response('asset') }
  };
}

async function call(env, path, { user, method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-telegram-init-data'] = await signInitData(TOKEN, user);
  const res = await worker.fetch(new Request(`https://tochnyak.test${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: res.status, data: await res.json() };
}

function rawMatch(id, utcDate, status = 'TIMED', score = null) {
  return {
    id, utcDate, status,
    competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' },
    awayTeam: { name: 'Liverpool FC', shortName: 'Liverpool', tla: 'LIV' },
    score: { fullTime: score || { home: null, away: null } }
  };
}

const max = { id: 1, first_name: 'Макс', username: 'max' };
const vitya = { id: 2, first_name: 'Витя' };

test('без Telegram доступа нет', async () => {
  const env = makeEnv();
  const r = await call(env, '/api/me');
  assert.equal(r.status, 401);
});

test('вход только после согласия, без согласия пользователь не создаётся', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/me', { user: max });
  assert.equal(r.data.registered, false);
  r = await call(env, '/api/auth', { user: max, method: 'POST', body: {} });
  assert.equal(r.status, 400);
  r = await call(env, '/api/matches', { user: max });
  assert.equal(r.status, 403);
  r = await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
  assert.equal(r.data.registered, true);
  assert.equal(r.data.profile.firstName, 'Макс');
  r = await call(env, '/api/me', { user: max });
  assert.equal(r.data.registered, true);
});

test('полный круг: прогноз, закрытие, финал, аура, рейтинг, удаление', async () => {
  const env = makeEnv();
  await call(env, '/api/me', { user: max }); // создаёт схему
  const kickoff = new Date(Date.now() + 3600000).toISOString();
  await upsertMatches(env.DB, [rawMatch(100, kickoff), rawMatch(101, new Date(Date.now() + 120000).toISOString())]);

  await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
  await call(env, '/api/auth', { user: vitya, method: 'POST', body: { accept: true } });

  let r = await call(env, '/api/predictions', { user: max, method: 'POST', body: { matchId: 100, home: 2, away: 1 } });
  assert.equal(r.status, 200);
  r = await call(env, '/api/predictions', { user: vitya, method: 'POST', body: { matchId: 100, home: 0, away: 1 } });
  assert.equal(r.status, 200);
  r = await call(env, '/api/predictions', { user: max, method: 'POST', body: { matchId: 101, home: 1, away: 0 } });
  assert.equal(r.status, 409, 'до матча меньше 5 минут, приём закрыт');
  r = await call(env, '/api/predictions', { user: max, method: 'POST', body: { matchId: 100, home: 2, away: 99 } });
  assert.equal(r.status, 400);

  r = await call(env, '/api/matches', { user: max });
  const m100 = r.data.matches.find((m) => m.id === 100);
  assert.deepEqual(m100.prediction, { home: 2, away: 1, points: null });
  assert.equal(m100.open, true);
  assert.equal(r.data.matches.find((m) => m.id === 101).open, false);

  // Матч сыгран 2:1.
  await upsertMatches(env.DB, [rawMatch(100, kickoff, 'FINISHED', { home: 2, away: 1 })]);
  assert.equal(await settleFinished(env.DB), 1);
  assert.equal(await settleFinished(env.DB), 0, 'второй раз аура не начисляется');

  r = await call(env, '/api/me', { user: max });
  assert.equal(r.data.profile.aura, 12, 'точняк 10 + обе забьют 1 + тотал 1');
  assert.equal(r.data.profile.weekAura, 12);
  assert.equal(r.data.profile.exactHits, 1);

  r = await call(env, '/api/leaderboard?period=week', { user: vitya });
  assert.equal(r.data.rows.length, 1);
  assert.equal(r.data.rows[0].name, 'Макс');
  assert.equal(r.data.me.rank, null);

  r = await call(env, '/api/leaderboard?period=all', { user: max });
  assert.equal(r.data.me.rank, 1);
  assert.equal(r.data.rows[0].isMe, true);

  // Прогноз на сыгранный матч поменять нельзя.
  r = await call(env, '/api/predictions', { user: max, method: 'POST', body: { matchId: 100, home: 0, away: 0 } });
  assert.equal(r.status, 409);

  // Удаление аккаунта стирает пользователя и его прогнозы.
  r = await call(env, '/api/me', { user: max, method: 'DELETE' });
  assert.equal(r.data.deleted, true);
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM predictions WHERE user_id = 1').first();
  assert.equal(left.n, 0);
  r = await call(env, '/api/me', { user: max });
  assert.equal(r.data.registered, false);
});

test('бот отвечает только с правильным секретом', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('https://tochnyak.test/bot/webhook', {
    method: 'POST', body: '{}', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }
  }), env);
  assert.equal(res.status, 403);
  const setup = await worker.fetch(new Request('https://tochnyak.test/setup?key=wrong'), env);
  assert.equal(setup.status, 403);
});

test('неделя начинается в понедельник 00:00 по Москве', () => {
  // Суббота 31.10.2026 01:00 МСК = пятница 22:00 UTC.
  assert.equal(weekStartIso(Date.parse('2026-10-30T22:00:00Z')), '2026-10-25T21:00:00.000Z');
  // Понедельник 02.11.2026 00:30 МСК = воскресенье 21:30 UTC, уже новая неделя.
  assert.equal(weekStartIso(Date.parse('2026-11-01T21:30:00Z')), '2026-11-01T21:00:00.000Z');
});
