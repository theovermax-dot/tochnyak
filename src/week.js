// Неделя рейтинга начинается в понедельник 00:00 по Москве.
const MSK_OFFSET = 3 * 3600000;

export function weekStartIso(now = Date.now()) {
  const msk = new Date(now + MSK_OFFSET);
  const dayFromMonday = (msk.getUTCDay() + 6) % 7;
  const mondayMsk = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - dayFromMonday);
  return new Date(mondayMsk - MSK_OFFSET).toISOString();
}
