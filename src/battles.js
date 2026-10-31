// Бои с друзьями: двое выбирают одни и те же матчи и ставят свои прогнозы.
// Это чисто на интерес: аура и монеты за бой не начисляются.
//
// Очки боя за матч: точный счёт 3, верная разница мячей 2, только исход 1.
// Прогноз соперника скрыт, пока на матч принимаются прогнозы, чтобы его нельзя было списать.

import { outcomeOf } from './scoring.js';
import { nowIso } from './db.js';

export const BATTLE = { minMatches: 1, maxMatches: 10, maxOpen: 20 };
export const BATTLE_POINTS = { exact: 3, diff: 2, outcome: 1 };

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const BATTLE_ID = /^[a-z0-9]{10}$/;

function newBattleId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

// Бой на победу: угадал исход — 1 очко. Счёт храним условно: 1:0, 0:0 или 0:1.
export const BATTLE_MODES = ['outcome', 'score'];
const signPick = (p) => {
  const o = outcomeOf(p.home, p.away);
  return { ...p, home: o === 'home' ? 1 : 0, away: o === 'away' ? 1 : 0 };
};

export function battlePoints(pred, result, mode = 'score') {
  if (!pred || !result) return 0;
  if (mode === 'outcome') return outcomeOf(pred.home, pred.away) === outcomeOf(result.home, result.away) ? BATTLE_POINTS.outcome : 0;
  if (pred.home === result.home && pred.away === result.away) return BATTLE_POINTS.exact;
  if (outcomeOf(pred.home, pred.away) !== outcomeOf(result.home, result.away)) return 0;
  if (pred.home - pred.away === result.home - result.away) return BATTLE_POINTS.diff;
  return BATTLE_POINTS.outcome;
}

const OPEN_STATUSES = ['SCHEDULED', 'TIMED'];
const isOpen = (m, now, lockMs) => OPEN_STATUSES.includes(m.status) && now < Date.parse(m.utc_date) - lockMs;
const isOver = (m) => (m.status === 'FINISHED' && m.home_score != null) || m.status === 'CANCELLED';

const validGoals = (n) => Number.isInteger(n) && n >= 0 && n <= 15;

function cleanPicks(list) {
  if (!Array.isArray(list)) return null;
  const out = new Map();
  for (const p of list) {
    if (!p || !Number.isInteger(p.matchId) || !validGoals(p.home) || !validGoals(p.away)) return null;
    out.set(p.matchId, { matchId: p.matchId, home: p.home, away: p.away });
  }
  return [...out.values()];
}

async function areFriends(db, a, b) {
  return Boolean(await db.prepare('SELECT 1 AS ok FROM friends WHERE user_id = ?1 AND friend_id = ?2').bind(a, b).first());
}

async function matchRows(db, ids) {
  if (!ids.length) return [];
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await db.prepare(`SELECT * FROM matches WHERE id IN (${marks})`).bind(...ids).all();
  return results;
}

// Создать бой. Создатель сразу ставит свои прогнозы на выбранные матчи.
export async function createBattle(db, { userId, friendCode, picks, mode = 'outcome', now, lockMs }) {
  if (!BATTLE_MODES.includes(mode)) return { error: [400, 'bad_mode', 'Неизвестный режим боя'] };
  const friend = await db.prepare('SELECT id, first_name FROM users WHERE friend_code = ?1').bind(String(friendCode || '')).first();
  if (!friend || friend.id === userId) return { error: [404, 'no_friend', 'Друг не найден'] };
  if (!(await areFriends(db, userId, friend.id))) return { error: [403, 'not_friend', 'Бой можно начать только с другом'] };
  let clean = cleanPicks(picks);
  if (clean && mode === 'outcome') clean = clean.map(signPick);
  if (!clean || clean.length < BATTLE.minMatches) return { error: [400, 'bad_picks', 'Выбери хотя бы один матч'] };
  if (clean.length > BATTLE.maxMatches) return { error: [400, 'too_many_matches', `В бою максимум ${BATTLE.maxMatches} матчей`] };
  const rows = await matchRows(db, clean.map((p) => p.matchId));
  if (rows.length !== clean.length || rows.some((m) => !isOpen(m, now, lockMs))) {
    return { error: [409, 'locked', 'Один из матчей уже начался, выбери другие'] };
  }
  const open = await db.prepare(
    "SELECT COUNT(*) AS n FROM battles WHERE (creator_id = ?1 OR opponent_id = ?1) AND status IN ('pending', 'active')"
  ).bind(userId).first();
  if (open.n >= BATTLE.maxOpen) return { error: [409, 'too_many_battles', 'Слишком много открытых боёв. Дождись, пока закончатся старые'] };

  const id = newBattleId();
  const at = nowIso(now);
  await db.batch([
    db.prepare("INSERT INTO battles (id, creator_id, opponent_id, status, created_at, mode) VALUES (?1, ?2, ?3, 'pending', ?4, ?5)")
      .bind(id, userId, friend.id, at, mode),
    ...clean.map((p) => db.prepare('INSERT INTO battle_matches (battle_id, match_id) VALUES (?1, ?2)').bind(id, p.matchId)),
    ...clean.map((p) => db.prepare(`INSERT INTO battle_picks (battle_id, user_id, match_id, home, away, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(id, userId, p.matchId, p.home, p.away, at))
  ]);
  return { id, opponentId: friend.id, opponentName: friend.first_name || 'Друг' };
}

async function battleRow(db, id, userId) {
  const b = await db.prepare(`SELECT b.*, c.first_name AS creator_name, o.first_name AS opponent_name, c.photo_url AS creator_photo, o.photo_url AS opponent_photo
    FROM battles b LEFT JOIN users c ON c.id = b.creator_id LEFT JOIN users o ON o.id = b.opponent_id
    WHERE b.id = ?1`).bind(id).first();
  if (!b || (b.creator_id !== userId && b.opponent_id !== userId)) return null;
  return b;
}

// Поставить или поменять свои прогнозы. Соперник этим же запросом принимает бой.
export async function savePicks(db, { battleId, userId, picks, now, lockMs }) {
  const b = await battleRow(db, battleId, userId);
  if (!b) return { error: [404, 'no_battle', 'Бой не найден'] };
  if (!['pending', 'active'].includes(b.status)) return { error: [409, 'closed', 'Этот бой уже закрыт'] };
  let clean = cleanPicks(picks);
  if (clean && b.mode === 'outcome') clean = clean.map(signPick);
  if (!clean || !clean.length) return { error: [400, 'bad_picks', 'Поставь счёт хотя бы на один матч'] };
  const { results: inBattle } = await db.prepare('SELECT match_id FROM battle_matches WHERE battle_id = ?1').bind(battleId).all();
  const allowed = new Set(inBattle.map((r) => r.match_id));
  if (clean.some((p) => !allowed.has(p.matchId))) return { error: [400, 'bad_picks', 'Этого матча нет в бою'] };
  const rows = await matchRows(db, clean.map((p) => p.matchId));
  const openIds = new Set(rows.filter((m) => isOpen(m, now, lockMs)).map((m) => m.id));
  const usable = clean.filter((p) => openIds.has(p.matchId));
  if (!usable.length) return { error: [409, 'locked', 'Матчи уже начались, прогнозы закрыты'] };
  const at = nowIso(now);
  const stmts = usable.map((p) => db.prepare(`INSERT INTO battle_picks (battle_id, user_id, match_id, home, away, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(battle_id, user_id, match_id) DO UPDATE SET home = excluded.home, away = excluded.away, updated_at = excluded.updated_at`)
    .bind(battleId, userId, p.matchId, p.home, p.away, at));
  const accepted = b.status === 'pending' && b.opponent_id === userId;
  if (accepted) stmts.push(db.prepare("UPDATE battles SET status = 'active', accepted_at = ?1 WHERE id = ?2").bind(at, battleId));
  await db.batch(stmts);
  return { saved: usable.length, skipped: clean.length - usable.length, accepted, creatorId: b.creator_id, opponentName: b.opponent_name };
}

// Отказаться (соперник) или отменить (создатель, пока бой не принят).
export async function closeBattle(db, { battleId, userId }) {
  const b = await battleRow(db, battleId, userId);
  if (!b) return { error: [404, 'no_battle', 'Бой не найден'] };
  if (b.status !== 'pending') return { error: [409, 'closed', 'Принятый бой уже не отменить'] };
  const status = b.opponent_id === userId ? 'declined' : 'cancelled';
  await db.prepare('UPDATE battles SET status = ?1 WHERE id = ?2').bind(status, battleId).run();
  return { status, creatorId: b.creator_id, opponentId: b.opponent_id };
}

// Собирает бой для экрана: матчи, прогнозы обоих, счёт и итог.
function summarize(b, matches, picks, userId, now, lockMs) {
  const meIsCreator = b.creator_id === userId;
  const otherId = meIsCreator ? b.opponent_id : b.creator_id;
  const byUser = (uid, mid) => picks.find((p) => p.user_id === uid && p.match_id === mid) || null;
  let my = 0;
  let their = 0;
  let decided = 0;
  const items = matches.map((m) => {
    const score = m.home_score == null ? null : { home: m.home_score, away: m.away_score };
    const mine = byUser(userId, m.id);
    const theirs = byUser(otherId, m.id);
    const open = isOpen(m, now, lockMs);
    const finished = m.status === 'FINISHED' && score;
    const myPts = finished && mine ? battlePoints(mine, score, b.mode) : null;
    const theirPts = finished && theirs ? battlePoints(theirs, score, b.mode) : null;
    if (finished) { decided += 1; my += myPts || 0; their += theirPts || 0; }
    return {
      matchId: m.id,
      open,
      over: isOver(m),
      mine: mine ? { home: mine.home, away: mine.away, pts: myPts } : null,
      // Пока матч открыт, видно только, что соперник уже поставил прогноз.
      theirs: theirs ? (open ? { hidden: true } : { home: theirs.home, away: theirs.away, pts: theirPts }) : null
    };
  });
  const allOver = matches.length > 0 && matches.every(isOver);
  let status = b.status;
  if (status === 'active' && allOver) status = 'done';
  if (status === 'pending' && !matches.some((m) => isOpen(m, now, lockMs))) status = 'expired';
  const result = status === 'done' ? (my > their ? 'win' : my < their ? 'lose' : 'draw') : null;
  const needsMyPicks = ['pending', 'active'].includes(status) && items.some((i) => i.open && !i.mine);
  return {
    id: b.id,
    status,
    mode: b.mode || 'score',
    role: meIsCreator ? 'creator' : 'opponent',
    opponent: { name: (meIsCreator ? b.opponent_name : b.creator_name) || 'Друг', photo: (meIsCreator ? b.opponent_photo : b.creator_photo) || null },
    createdAt: b.created_at,
    score: { me: my, them: their },
    decided,
    total: matches.length,
    result,
    needsMyPicks,
    items
  };
}

async function loadParts(db, battleIds) {
  if (!battleIds.length) return { links: [], matches: [], picks: [] };
  const marks = battleIds.map((_, i) => `?${i + 1}`).join(',');
  const { results: links } = await db.prepare(`SELECT battle_id, match_id FROM battle_matches WHERE battle_id IN (${marks})`).bind(...battleIds).all();
  const { results: picks } = await db.prepare(`SELECT * FROM battle_picks WHERE battle_id IN (${marks})`).bind(...battleIds).all();
  const matches = await matchRows(db, [...new Set(links.map((l) => l.match_id))]);
  return { links, matches, picks };
}

function assemble(b, parts, userId, now, lockMs) {
  const ids = parts.links.filter((l) => l.battle_id === b.id).map((l) => l.match_id);
  const matches = parts.matches.filter((m) => ids.includes(m.id)).sort((x, y) => x.utc_date.localeCompare(y.utc_date) || x.id - y.id);
  const picks = parts.picks.filter((p) => p.battle_id === b.id);
  const battle = summarize(b, matches, picks, userId, now, lockMs);
  battle.lastAt = matches.length ? matches[matches.length - 1].utc_date : b.created_at;
  return { battle, matches };
}

export async function listBattles(db, { userId, now, lockMs }) {
  const { results } = await db.prepare(`SELECT b.*, c.first_name AS creator_name, o.first_name AS opponent_name, c.photo_url AS creator_photo, o.photo_url AS opponent_photo
    FROM battles b LEFT JOIN users c ON c.id = b.creator_id LEFT JOIN users o ON o.id = b.opponent_id
    WHERE (b.creator_id = ?1 OR b.opponent_id = ?1) AND b.status IN ('pending', 'active')
       OR ((b.creator_id = ?1 OR b.opponent_id = ?1) AND b.status = 'declined' AND b.created_at >= ?2)
    ORDER BY b.created_at DESC LIMIT 40`).bind(userId, nowIso(now - 3 * 86400000)).all();
  const parts = await loadParts(db, results.map((b) => b.id));
  const list = results.map((b) => assemble(b, parts, userId, now, lockMs).battle);
  // Сыгранные бои держим в списке ещё 3 дня, просроченные приглашения прячем.
  const fresh = list.filter((b) => b.status !== 'expired'
    && !(b.status === 'done' && Date.parse(b.lastAt) < now - 3 * 86400000));
  const order = (b) => (b.needsMyPicks ? 0 : b.status === 'active' ? 1 : b.status === 'pending' ? 2 : 3);
  fresh.sort((a, b) => order(a) - order(b));
  return fresh.map(({ items, ...rest }) => rest);
}

export async function getBattle(db, { battleId, userId, now, lockMs }) {
  const b = await battleRow(db, battleId, userId);
  if (!b) return null;
  const parts = await loadParts(db, [b.id]);
  return assemble(b, parts, userId, now, lockMs);
}

export async function deleteUserBattles(db, userId) {
  const { results } = await db.prepare('SELECT id FROM battles WHERE creator_id = ?1 OR opponent_id = ?1').bind(userId).all();
  const stmts = [];
  for (const { id } of results) {
    stmts.push(db.prepare('DELETE FROM battle_picks WHERE battle_id = ?1').bind(id));
    stmts.push(db.prepare('DELETE FROM battle_matches WHERE battle_id = ?1').bind(id));
    stmts.push(db.prepare('DELETE FROM battles WHERE id = ?1').bind(id));
  }
  if (stmts.length) await db.batch(stmts);
}
