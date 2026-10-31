// Личная статистика игрока: сколько угадано всего, точных счетов и серия попаданий подряд.
// Считается по уже рассчитанным прогнозам (settled_at заполнен), новые сверху.

// Точный счёт — только прогноз на счёт (не «только победа») и совпадение с результатом матча.
export function isExactHit(r) {
  return r.kind !== 'outcome' && r.home === r.hs && r.away === r.ast;
}

export function profileStats(rows) {
  let total = 0;
  let hits = 0;
  let exact = 0;
  let streak = 0;
  let streakOpen = true;
  for (const r of rows) {
    total += 1;
    const hit = r.points > 0;
    if (streakOpen) {
      if (hit) streak += 1;
      else streakOpen = false;
    }
    if (hit) hits += 1;
    if (isExactHit(r)) exact += 1;
  }
  return { total, hits, exact, streak };
}
