import test from 'node:test';
import assert from 'node:assert/strict';
import { safePhoto, validateInitData } from '../src/telegram.js';
import { signInitData } from './helpers.js';

const TOKEN = '123456:TEST_TOKEN_FOR_TESTS_ONLY';
const user = { id: 42, first_name: 'Макс', last_name: 'Скрыто', username: 'tester', language_code: 'ru' };

test('правильная подпись принимается, фамилия не сохраняется', async () => {
  const initData = await signInitData(TOKEN, user);
  const result = await validateInitData(initData, TOKEN);
  assert.deepEqual(result, { id: 42, firstName: 'Макс', username: 'tester', languageCode: 'ru', photoUrl: null });
});

test('подпись чужим токеном отклоняется', async () => {
  const initData = await signInitData('999:OTHER', user);
  assert.equal(await validateInitData(initData, TOKEN), null);
});

test('подделанные данные отклоняются', async () => {
  const initData = await signInitData(TOKEN, user);
  const forged = initData.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
  assert.notEqual(forged, initData);
  assert.equal(await validateInitData(forged, TOKEN), null);
});

test('устаревшие данные отклоняются', async () => {
  const old = Math.floor(Date.now() / 1000) - 2 * 86400;
  const initData = await signInitData(TOKEN, user, old);
  assert.equal(await validateInitData(initData, TOKEN), null);
});

test('пустые данные отклоняются', async () => {
  assert.equal(await validateInitData('', TOKEN), null);
  assert.equal(await validateInitData('hash=abc', TOKEN), null);
});

test('аватарка: только ссылки Telegram', () => {
  assert.equal(safePhoto('https://t.me/i/userpic/320/abc.svg'), 'https://t.me/i/userpic/320/abc.svg');
  assert.equal(safePhoto('https://evil.example/x.jpg'), null);
  assert.equal(safePhoto('javascript:alert(1)'), null);
  assert.equal(safePhoto('https://t.me/i/"onerror="x'), null);
});
