import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { weekStartIso, inviteCaption } from '../src/index.js';
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
  assert.equal(r.data.profile.coins, 5, 'за точный счёт 5 монет');
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

test('друзья: приглашение по коду, общий рейтинг, удаление', async () => {
  const env = makeEnv();
  let r = await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
  const code = r.data.profile.friendCode;
  assert.match(code, /^[a-z0-9]{8}$/);
  await call(env, '/api/auth', { user: vitya, method: 'POST', body: { accept: true } });

  r = await call(env, '/api/friends', { user: vitya, method: 'POST', body: { code } });
  assert.deepEqual(r.data, { added: true, name: 'Макс' });
  r = await call(env, '/api/friends', { user: vitya, method: 'POST', body: { code } });
  assert.equal(r.data.added, false, 'повторно не дублируется');
  r = await call(env, '/api/friends', { user: max, method: 'POST', body: { code } });
  assert.equal(r.data.self, true);
  r = await call(env, '/api/friends', { user: max, method: 'POST', body: { code: 'zzzzzzzz' } });
  assert.equal(r.status, 404);

  r = await call(env, '/api/friends?period=all', { user: max });
  assert.equal(r.data.rows.length, 2, 'дружба взаимная');
  assert.equal(r.data.link, `https://t.me/tochnyak_bot?start=f_${code}`);
  const vityaCode = r.data.rows.find((x) => !x.isMe).code;
  assert.equal(r.data.rows.find((x) => x.isMe).code, null);

  r = await call(env, '/api/me', { user: vitya });
  assert.equal(r.data.profile.friendsCount, 1);
  r = await call(env, '/api/me', { user: max });
  assert.equal(r.data.profile.coins, 10, 'новичок по ссылке приносит 10 монет');

  r = await call(env, `/api/friends?code=${vityaCode}`, { user: max, method: 'DELETE' });
  r = await call(env, '/api/friends', { user: vitya });
  assert.equal(r.data.rows.length, 1);
});

test('мои прогнозы и эмблемы клубов', async () => {
  const env = makeEnv();
  await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
  const raw = rawMatch(200, new Date(Date.now() + 3600000).toISOString());
  raw.homeTeam.crest = 'https://crests.football-data.org/57.png';
  raw.awayTeam.crest = 'https://evil.example/x.svg';
  await upsertMatches(env.DB, [raw]);
  await call(env, '/api/predictions', { user: max, method: 'POST', body: { matchId: 200, home: 1, away: 0 } });
  const r = await call(env, '/api/my', { user: max });
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].home.crest, '/crest/57.png?v=2');
  assert.equal(r.data.items[0].away.crest, null, 'чужие адреса не пропускаем');
  assert.deepEqual(r.data.items[0].prediction, { home: 1, away: 0, points: null });
  const bad = await worker.fetch(new Request('https://tochnyak.test/crest/a%2Fb.png'), env);
  assert.equal(bad.status, 404);
});

test('приглашение: подпись, готовое сообщение и страница с превью', async () => {
  assert.match(inviteCaption('<Макс>'), /Вызов от &lt;Макс&gt;/);
  const env = makeEnv();
  const r0 = await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
  const code = r0.data.profile.friendCode;

  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (u, opts) => {
    sent = { url: String(u), body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ ok: true, result: { id: 'prep1', expiration_date: 0 } }));
  };
  try {
    const r = await call(env, '/api/invite', { user: max, method: 'POST' });
    assert.equal(r.data.id, 'prep1');
    assert.match(sent.url, /savePreparedInlineMessage$/);
    assert.equal(sent.body.user_id, 1);
    assert.equal(sent.body.result.type, 'photo');
    assert.equal(sent.body.result.photo_url, 'https://tochnyak.test/invite.jpg');
    assert.equal(sent.body.result.reply_markup.inline_keyboard[0][0].url, `https://t.me/tochnyak_bot?start=f_${code}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  const page = await worker.fetch(new Request(`https://tochnyak.test/i/${code}`), env);
  const html = await page.text();
  assert.match(html, /og:image" content="https:\/\/tochnyak.test\/invite.jpg/);
  assert.match(html, new RegExp(`start=f_${code}`));
});

test('магазин: покупка за монеты, нехватка, выбор', async () => {
  const chars = await import('../src/characters.js');
  chars.CHARACTERS.push({ id: 'test-hero', name: 'Тест', price: 30, rarity: 'Редкий' });
  try {
    const env = makeEnv();
    await call(env, '/api/auth', { user: max, method: 'POST', body: { accept: true } });
    let r = await call(env, '/api/shop', { user: max });
    assert.equal(r.data.selected, 'tochnyak');
    assert.equal(r.data.items.find((i) => i.id === 'tochnyak').owned, true);
    r = await call(env, '/api/shop/buy', { user: max, method: 'POST', body: { id: 'test-hero' } });
    assert.equal(r.status, 409, 'монет нет');
    r = await call(env, '/api/shop/select', { user: max, method: 'POST', body: { id: 'test-hero' } });
    assert.equal(r.status, 403);
    env.DB.db.exec('UPDATE users SET coins = 40 WHERE id = 1');
    r = await call(env, '/api/shop/buy', { user: max, method: 'POST', body: { id: 'test-hero' } });
    assert.equal(r.data.coins, 10);
    assert.equal(r.data.selected, 'test-hero');
    r = await call(env, '/api/shop/buy', { user: max, method: 'POST', body: { id: 'test-hero' } });
    assert.equal(r.data.coins, 10, 'второй раз не списывает');
    r = await call(env, '/api/shop/select', { user: max, method: 'POST', body: { id: 'tochnyak' } });
    assert.equal(r.data.selected, 'tochnyak');
    r = await call(env, '/api/me', { user: max });
    assert.equal(r.data.profile.character, 'tochnyak');
  } finally {
    chars.CHARACTERS.pop();
  }
});
