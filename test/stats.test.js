import test from 'node:test';
import assert from 'node:assert/strict';
import { profileStats } from '../src/stats.js';

test('статистика: всего угадано, точные счёты без «разницы с редкостью», серия', () => {
  const rows = [
    { points: 10, kind: 'score', home: 2, away: 1, hs: 2, ast: 1 },
    // Разница мячей с редкостью даёт 14 очков, но точным счётом не является.
    { points: 14, kind: 'score', home: 3, away: 1, hs: 2, ast: 1 },
    { points: 0, kind: 'score', home: 0, away: 0, hs: 1, ast: 0 },
    { points: 2, kind: 'outcome', home: 1, away: 0, hs: 1, ast: 0 }
  ];
  assert.deepEqual(profileStats(rows), { total: 4, hits: 3, exact: 1, streak: 2 });
});

test('статистика: пустая история и серия без попаданий', () => {
  assert.deepEqual(profileStats([]), { total: 0, hits: 0, exact: 0, streak: 0 });
  assert.equal(profileStats([{ points: 0, kind: 'score', home: 1, away: 0, hs: 0, ast: 0 }]).streak, 0);
});
