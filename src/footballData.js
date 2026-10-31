// Синхронизация матчей с football-data.org и начисление ауры после финального свистка.
// Бесплатный тариф: 10 запросов в минуту, счёт приходит с задержкой. Мы делаем
// один запрос за запуск расписания, поэтому лимит не трогаем.

import { nowIso } from './db.js';
import { scoreMatch } from './scoring.js';

const API = 'https://api.football-data.org/v4';
const DAY = 86400000;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// Счёт основного времени: для матчей с овертаймом и пенальти берём regularTime.
export function regularScore(score) {
  const s = score && score.regularTime && score.regularTime.home != null ? score.regularTime : score && score.fullTime;
  if (!s || s.home == null || s.away == null) return null;
  return { home: s.home, away: s.away };
}

// Из адреса эмблемы оставляем только имя файла: картинки отдаём через свой /crest/,
// чтобы устройство игрока не ходило на сторонний сервер.
export function crestFile(url) {
  const m = /^https:\/\/crests\.football-data\.org\/([A-Za-z0-9_-]{1,40}\.(?:png|svg|gif))$/.exec(url || '');
  return m ? m[1] : null;
}

export function mapMatch(m, now = Date.now()) {
  if (!m.homeTeam || !m.awayTeam || !m.homeTeam.name || !m.awayTeam.name) return null;
  const score = regularScore(m.score);
  const short = (t) => t.shortName || t.name;
  const tla = (t) => (t.tla || short(t).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3)).toUpperCase();
  return {
    id: m.id,
    competition: m.competition.code,
    competitionName: m.competition.name,
    utcDate: m.utcDate,
    status: m.status,
    homeName: m.homeTeam.name,
    homeShort: short(m.homeTeam),
    homeTla: tla(m.homeTeam),
    awayName: m.awayTeam.name,
    awayShort: short(m.awayTeam),
    awayTla: tla(m.awayTeam),
    homeCrest: crestFile(m.homeTeam.crest),
    awayCrest: crestFile(m.awayTeam.crest),
    homeScore: score ? score.home : null,
    awayScore: score ? score.away : null,
    updatedAt: nowIso(now)
  };
}

export async function fetchMatches(env, now = Date.now()) {
  const params = new URLSearchParams({
    competitions: env.COMPETITIONS,
    dateFrom: day(now - 2 * DAY),
    dateTo: day(now + 7 * DAY)
  });
  const res = await fetch(`${API}/matches?${params}`, { headers: { 'X-Auth-Token': env.FOOTBALL_DATA_TOKEN } });
  if (res.status === 429) return { ok: false, reason: 'rate-limited' };
  if (!res.ok) return { ok: false, reason: `http ${res.status}` };
  const body = await res.json();
  return { ok: true, matches: body.matches || [] };
}

export async function upsertMatches(db, rawMatches, now = Date.now()) {
  const rows = rawMatches.map((m) => mapMatch(m, now)).filter(Boolean);
  if (!rows.length) return 0;
  const stmt = db.prepare(`INSERT INTO matches
    (id, competition, competition_name, utc_date, status, home_name, home_short, home_tla,
     away_name, away_short, away_tla, home_score, away_score, settled, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)
    ON CONFLICT(id) DO UPDATE SET
      utc_date = excluded.utc_date, status = excluded.status,
      home_name = excluded.home_name, home_short = excluded.home_short, home_tla = excluded.home_tla,
      away_name = excluded.away_name, away_short = excluded.away_short, away_tla = excluded.away_tla,
      home_score = excluded.home_score, away_score = excluded.away_score, updated_at = excluded.updated_at
    WHERE matches.settled = 0`);
  // Эмблемы обновляем и у уже рассчитанных матчей.
  const crests = db.prepare(`UPDATE matches SET home_crest = ?2, away_crest = ?3
    WHERE id = ?1 AND (home_crest IS NOT ?2 OR away_crest IS NOT ?3)`);
  await db.batch(rows.flatMap((r) => [
    stmt.bind(
      r.id, r.competition, r.competitionName, r.utcDate, r.status, r.homeName, r.homeShort, r.homeTla,
      r.awayName, r.awayShort, r.awayTla, r.homeScore, r.awayScore, r.updatedAt
    ),
    crests.bind(r.id, r.homeCrest, r.awayCrest)
  ]));
  return rows.length;
}

// Начисляет ауру за все завершённые и ещё не рассчитанные матчи.
export async function settleFinished(db, now = Date.now()) {
  const { results: matches } = await db.prepare(
    `SELECT id, home_score, away_score FROM matches
     WHERE status = 'FINISHED' AND settled = 0 AND home_score IS NOT NULL AND away_score IS NOT NULL`
  ).all();
  let settled = 0;
  for (const m of matches) {
    // Сначала «занимаем» матч, чтобы два запуска подряд не начислили ауру дважды.
    const claim = await db.prepare('UPDATE matches SET settled = 2 WHERE id = ?1 AND settled = 0').bind(m.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const { results: preds } = await db.prepare(
      'SELECT user_id AS userId, home, away, kind FROM predictions WHERE match_id = ?1'
    ).bind(m.id).all();
    const scored = scoreMatch(preds, { home: m.home_score, away: m.away_score });
    const at = nowIso(now);
    const statements = [];
    for (const s of scored) {
      statements.push(db.prepare(
        'UPDATE predictions SET points = ?1, settled_at = ?2 WHERE user_id = ?3 AND match_id = ?4'
      ).bind(s.points, at, s.userId, m.id));
      if (s.points || s.coins) {
        statements.push(db.prepare('UPDATE users SET aura = aura + ?1, coins = coins + ?2 WHERE id = ?3').bind(s.points, s.coins, s.userId));
      }
    }
    statements.push(db.prepare('UPDATE matches SET settled = 1 WHERE id = ?1').bind(m.id));
    await db.batch(statements);
    settled += 1;
  }
  return settled;
}

export async function syncAndSettle(env, now = Date.now()) {
  const fetched = await fetchMatches(env, now);
  let upserted = 0;
  if (fetched.ok) upserted = await upsertMatches(env.DB, fetched.matches, now);
  const settled = await settleFinished(env.DB, now);
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind('last_sync', JSON.stringify({ at: nowIso(now), ok: fetched.ok, reason: fetched.reason || null, upserted, settled }))
    .run();
  return { ok: fetched.ok, reason: fetched.reason, upserted, settled };
}
