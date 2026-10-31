// Схема базы D1. Таблицы создаются сами при первом запросе после деплоя,
// поэтому отдельные миграции из консоли запускать не нужно.
//
// Храним минимум: id Telegram, имя, username и язык. Номер телефона — только если игрок
// сам поделился им через кнопку Telegram, чтобы друзья могли найти его. Фамилию и фото не храним.

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
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Купленные персонажи. Базовый есть у всех и сюда не пишется.
  `CREATE TABLE IF NOT EXISTS owned_characters (
    user_id INTEGER NOT NULL,
    character_id TEXT NOT NULL,
    bought_at TEXT NOT NULL,
    price INTEGER NOT NULL,
    PRIMARY KEY (user_id, character_id)
  )`,
  // Друзья: связь хранится в обе стороны, чтобы список читался одним запросом.
  `CREATE TABLE IF NOT EXISTS friends (
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  )`,
  // Бои с друзьями: на интерес, без ауры и монет.
  `CREATE TABLE IF NOT EXISTS battles (
    id TEXT PRIMARY KEY,
    creator_id INTEGER NOT NULL,
    opponent_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS battles_by_creator ON battles (creator_id)`,
  `CREATE INDEX IF NOT EXISTS battles_by_opponent ON battles (opponent_id)`,
  `CREATE TABLE IF NOT EXISTS battle_matches (
    battle_id TEXT NOT NULL,
    match_id INTEGER NOT NULL,
    PRIMARY KEY (battle_id, match_id)
  )`,
  `CREATE TABLE IF NOT EXISTS battle_picks (
    battle_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    home INTEGER NOT NULL,
    away INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (battle_id, user_id, match_id)
  )`,
  // Уведомления в приложении: вызовы на бой, ответы, новые друзья.
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    link TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications (user_id, id)`
];

// Колонки, добавленные после первого запуска. ALTER падает, если колонка уже есть, это нормально.
const COLUMNS = [
  'ALTER TABLE matches ADD COLUMN home_crest TEXT',
  'ALTER TABLE matches ADD COLUMN away_crest TEXT',
  'ALTER TABLE users ADD COLUMN friend_code TEXT',
  'ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE users ADD COLUMN character TEXT NOT NULL DEFAULT 'tochnyak'",
  'ALTER TABLE users ADD COLUMN phone TEXT',
  // Версия регистрации, которую игрок прошёл. Старые аккаунты получают 1 и проходят регистрацию заново.
  'ALTER TABLE users ADD COLUMN reg_version INTEGER NOT NULL DEFAULT 1',
  // score — точный счёт, outcome — только исход (П1 / ничья / П2).
  "ALTER TABLE predictions ADD COLUMN kind TEXT NOT NULL DEFAULT 'score'"
];

async function migrate(db) {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of COLUMNS) {
    try { await db.prepare(sql).run(); } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_by_friend_code ON users (friend_code)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS users_by_username ON users (username COLLATE NOCASE)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS users_by_phone ON users (phone)').run();
}

let schemaReady = null;

export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = migrate(db).catch((err) => {
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

// Код для ссылки-приглашения: 8 символов без похожих букв и цифр.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newFriendCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
