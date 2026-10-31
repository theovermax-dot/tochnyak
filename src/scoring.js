// Правила начисления ауры. Один файл, чтобы правила было легко менять.
//
// За матч засчитывается лучший из трёх результатов:
//   точный счёт 10, верная разница мячей 6, только исход 3.
// Бонусы (считаются из счёта прогноза, отдельно от основы):
//   «обе забьют» угадано +1, тотал больше/меньше 2,5 угадан +1.
// Редкость: если исход угадан и его выбрали меньше 10% игроков, основа ×2,
//   от 10 до 25% ×1,5. Работает, только когда на матч есть хотя бы
//   RARITY_MIN_PREDICTIONS прогнозов, иначе проценты ничего не значат.

export const POINTS = { exact: 10, diff: 6, outcome: 3, btts: 1, total: 1, winOnly: 2 };
export const RARITY_MIN_PREDICTIONS = 20;

export function outcomeOf(home, away) {
  if (home > away) return 'home';
  if (home < away) return 'away';
  return 'draw';
}

export function basePoints(pred, result) {
  if (pred.home === result.home && pred.away === result.away) return POINTS.exact;
  const sameOutcome = outcomeOf(pred.home, pred.away) === outcomeOf(result.home, result.away);
  if (!sameOutcome) return 0;
  if (pred.home - pred.away === result.home - result.away) return POINTS.diff;
  return POINTS.outcome;
}

export function bonusPoints(pred, result) {
  let bonus = 0;
  const bttsPred = pred.home > 0 && pred.away > 0;
  const bttsResult = result.home > 0 && result.away > 0;
  if (bttsPred === bttsResult) bonus += POINTS.btts;
  const overPred = pred.home + pred.away > 2.5;
  const overResult = result.home + result.away > 2.5;
  if (overPred === overResult) bonus += POINTS.total;
  return bonus;
}

// Монеты для гардероба: отдельная валюта, примерно вдвое меньше ауры. Рейтинг от них не зависит.
// winOnly — прогноз «просто на исход» без счёта: награда меньше, чем за исход в прогнозе на счёт.
export const COINS = { exact: 5, diff: 3, outcome: 2, friendJoined: 10, winOnly: 1 };
export function coinsFor(base) {
  if (base >= POINTS.exact) return COINS.exact;
  if (base >= POINTS.diff) return COINS.diff;
  if (base > 0) return COINS.outcome;
  return 0;
}

// share — доля игроков (0..1), выбравших тот же исход, что и этот прогноз.
export function rarityMultiplier(share, totalPredictions) {
  if (totalPredictions < RARITY_MIN_PREDICTIONS) return 1;
  if (share < 0.10) return 2;
  if (share < 0.25) return 1.5;
  return 1;
}

// Считает ауру за все прогнозы одного матча.
// predictions: [{ userId, home, away }], result: { home, away }
// Возвращает [{ userId, points, base, bonus, multiplier, coins }].
export function scoreMatch(predictions, result) {
  const total = predictions.length;
  const counts = { home: 0, draw: 0, away: 0 };
  for (const p of predictions) counts[outcomeOf(p.home, p.away)] += 1;

  return predictions.map((p) => {
    // Прогноз только на исход: 2 ауры и 1 монета, без бонусов и редкости.
    if (p.kind === 'outcome') {
      const hit = outcomeOf(p.home, p.away) === outcomeOf(result.home, result.away);
      return { userId: p.userId, points: hit ? POINTS.winOnly : 0, base: hit ? POINTS.winOnly : 0, bonus: 0, multiplier: 1, coins: hit ? COINS.winOnly : 0 };
    }
    const base = basePoints(p, result);
    const bonus = bonusPoints(p, result);
    const share = total ? counts[outcomeOf(p.home, p.away)] / total : 1;
    const multiplier = base > 0 ? rarityMultiplier(share, total) : 1;
    const points = Math.round(base * multiplier) + bonus;
    return { userId: p.userId, points, base, bonus, multiplier, coins: coinsFor(base) };
  });
}
