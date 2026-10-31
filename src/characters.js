// Персонажи, которых можно купить за монеты. Картинки лежат в public/chars/<id>/
// (front, right, back, left). Новый персонаж = новая строка здесь + папка с картинками.

export const DEFAULT_CHARACTER = 'tochnyak';

export const CHARACTERS = [
  { id: 'tochnyak', name: 'Точняк', price: 0, rarity: 'Базовый' }
];

export const characterById = (id) => CHARACTERS.find((c) => c.id === id) || null;
