// Схема базы D1. Таблицы создаются сами при первом запросе после деплоя,
// поэтому отдельные миграции из консоли запускать не нужно.
//
// Храним минимум: id Telegram, имя, username и язык. Фамилию, номер телефона
// и фото не храним.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    username TEXT,
    language_code TEXT,
    aura INTEGER NOT NULL DEFAULT 0,
    accepted_terms_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    competition TEXT NOT NULL,
    competition_name TEXT NOT NULL,
    utc_date TEXT NOT NULL,
    status TEXT NOT NULL,
    home_name TEXT NOT NULL,
    home_short TEXT NOT NULL,
    home_tla TEXT NOT NULL,
    away_name TEXT NOT NULL,
    away_short TEXT NOT NULL,
    away_tla TEXT NOT NULL,
    home_score INTEGER,
    away_score INTEGER,
    settled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS matches_by_date ON matches (utc_date)`,
  `CREATE TABLE IF NOT EXISTS predictions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES matches(id),
    home INTEGER NOT NULL,
    away INTEGER NOT NULL,
    points INTEGER,
    settled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, match_id)
  )`,
  `CREATE INDEX IF NOT EXISTS predictions_by_match ON predictions (match_id)`,
  `CREATE INDEX IF NOT EXISTS predictions_by_settled ON predictions (settled_at)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
];

let schemaReady = null;

export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// Только для тестов: сбросить флаг, чтобы схема создалась в новой базе.
export function resetSchemaFlag() {
  schemaReady = null;
}

export const nowIso = (now = Date.now()) => new Date(now).toISOString();
