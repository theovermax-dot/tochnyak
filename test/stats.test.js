import test from 'node:test';
import assert from 'node:assert/strict';
import { profileStats } from '../src/stats.js';

test('статистика: серия, точные счёты без «разницы с редкостью», разбивка по лигам', () => {
  const rows = [
    { competition: 'PL', points: 10, kind: 'score', home: 2, away: 1, hs: 2, ast: 1 },
    // Разница мячей с редкостью даёт 14 очков, но точным счётом не является.
    { competition: 'PL', points: 14, kind: 'score', home: 3, away: 1, hs: 2, ast: 1 },
    { competition: 'PD', points: 0, kind: 'score', home: 0, away: 0, hs: 1, ast: 0 },
    { competition: 'PL', points: 2, kind: 'outcome', home: 1, away: 0, hs: 1, ast: 0 }
  ];
  const s = profileStats(rows);
  assert.equal(s.total, 4);
  assert.equal(s.exact, 1);
  assert.equal(s.streak, 2);
  assert.deepEqual(s.leagues.map((l) => [l.competition, l.total, l.hits, l.exact]), [['PL', 3, 3, 1], ['PD', 1, 0, 0]]);
});

test('статистика: пустая история и серия без попаданий', () => {
  assert.deepEqual(profileStats([]), { total: 0, exact: 0, streak: 0, leagues: [] });
  assert.equal(profileStats([{ competition: 'PL', points: 0, kind: 'score', home: 1, away: 0, hs: 0, ast: 0 }]).streak, 0);
});
