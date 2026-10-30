// Вход через Telegram: проверка подписи initData мини-аппа и вызовы Bot API.
// Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const encoder = new TextEncoder();

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Возвращает пользователя Telegram, если подпись верна и данные не старше maxAgeSeconds.
// Иначе null. Токен бота нужен только для проверки, наружу он не уходит.
export async function validateInitData(initData, botToken, { maxAgeSeconds = 86400, now = Date.now() } = {}) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmac(encoder.encode('WebAppData'), botToken);
  const expected = toHex(await hmac(secretKey, dataCheckString));
  if (!timingSafeEqual(expected, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSeconds) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || typeof user.id !== 'number') return null;
  return {
    id: user.id,
    firstName: String(user.first_name || '').slice(0, 64),
    username: user.username ? String(user.username).slice(0, 64) : null,
    languageCode: user.language_code ? String(user.language_code).slice(0, 8) : null
  };
}

export async function botApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}
