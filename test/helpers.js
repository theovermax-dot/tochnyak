// Тестовые помощники: база D1 поверх встроенного SQLite в Node и подпись initData.
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)));
  }
  exec() {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { rows: stmt.all(...this.params) };
    const info = stmt.run(...this.params);
    return { rows: [], changes: Number(info.changes) };
  }
  async first() {
    const { rows } = this.exec();
    return rows[0] ? { ...rows[0] } : null;
  }
  async all() {
    const { rows } = this.exec();
    return { results: rows.map((r) => ({ ...r })) };
  }
  async run() {
    const { changes } = this.exec();
    return { success: true, meta: { changes } };
  }
}

export class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => {
        const r = s.exec();
        return { results: r.rows, meta: { changes: r.changes || 0 } };
      });
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

const enc = new TextEncoder();
async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// Собирает initData так же, как Telegram, подписывая его токеном бота.
export async function signInitData(botToken, user, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), query_id: 'AAH-test', user: JSON.stringify(user) };
  const dataCheckString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const hash = Array.from(await hmac(secret, dataCheckString), (b) => b.toString(16).padStart(2, '0')).join('');
  return new URLSearchParams({ ...fields, hash }).toString();
}
