// Личная статистика игрока: серия попаданий подряд и точность по лигам.
// Считается по уже рассчитанным прогнозам (settled_at заполнен), новые сверху.

// Точный счёт — только прогноз на счёт (не «только победа») и совпадение с результатом матча.
export function isExactHit(r) {
  return r.kind !== 'outcome' && r.home === r.hs && r.away === r.ast;
}

export function profileStats(rows) {
  let total = 0;
  let exact = 0;
  let streak = 0;
  let streakOpen = true;
  const leagues = new Map();
  for (const r of rows) {
    total += 1;
    const hit = r.points > 0;
    const exactHit = isExactHit(r);
    if (streakOpen) {
      if (hit) streak += 1;
      else streakOpen = false;
    }
    if (exactHit) exact += 1;
    const l = leagues.get(r.competition) || { competition: r.competition, total: 0, hits: 0, exact: 0 };
    l.total += 1;
    if (hit) l.hits += 1;
    if (exactHit) l.exact += 1;
    leagues.set(r.competition, l);
  }
  return { total, exact, streak, leagues: [...leagues.values()].sort((a, b) => b.total - a.total) };
}
