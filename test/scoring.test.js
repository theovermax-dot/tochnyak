import test from 'node:test';
import assert from 'node:assert/strict';
import { basePoints, bonusPoints, scoreMatch, rarityMultiplier } from '../src/scoring.js';

const r21 = { home: 2, away: 1 };

test('основа: точный счёт, разница, исход, мимо', () => {
  assert.equal(basePoints({ home: 2, away: 1 }, r21), 10);
  assert.equal(basePoints({ home: 3, away: 2 }, r21), 6);
  assert.equal(basePoints({ home: 1, away: 0 }, r21), 6);
  assert.equal(basePoints({ home: 3, away: 0 }, r21), 3);
  assert.equal(basePoints({ home: 1, away: 1 }, r21), 0);
  assert.equal(basePoints({ home: 0, away: 2 }, r21), 0);
});

test('ничья с другим счётом даёт разницу, а не точняк', () => {
  assert.equal(basePoints({ home: 2, away: 2 }, { home: 1, away: 1 }), 6);
  assert.equal(basePoints({ home: 0, away: 0 }, { home: 0, away: 0 }), 10);
});

test('бонусы: обе забьют и тотал 2,5', () => {
  assert.equal(bonusPoints({ home: 2, away: 1 }, r21), 2);
  assert.equal(bonusPoints({ home: 1, away: 0 }, r21), 0);
  assert.equal(bonusPoints({ home: 0, away: 0 }, { home: 1, away: 0 }), 2);
});

test('редкость включается только при 20+ прогнозах', () => {
  assert.equal(rarityMultiplier(0.05, 10), 1);
  assert.equal(rarityMultiplier(0.05, 20), 2);
  assert.equal(rarityMultiplier(0.2, 40), 1.5);
  assert.equal(rarityMultiplier(0.5, 40), 1);
});

test('пример из макета: точняк 2:1, победу выбрали 8%, итого 22', () => {
  // 25 игроков: 2 за победу хозяев (8%), остальные за ничью.
  const preds = [{ userId: 1, home: 2, away: 1 }, { userId: 2, home: 1, away: 0 }];
  for (let i = 3; i <= 25; i += 1) preds.push({ userId: i, home: 1, away: 1 });
  const scored = scoreMatch(preds, r21);
  assert.equal(scored.find((s) => s.userId === 1).points, 22);
  assert.equal(scored.find((s) => s.userId === 2).points, 12); // разница 6 ×2, бонусы 0
  assert.equal(scored.find((s) => s.userId === 3).points, 1); // мимо исхода, но тотал угадан
});
