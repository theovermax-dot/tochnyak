// Персонажи и их образы (скины) за монеты.
// Персонаж покупается целиком — вместе с первым образом. Остальные образы докупаются,
// только когда персонаж уже есть. Цены растут от первого образа к четвёртому.
//
// Картинки: public/chars/<id образа>/
//   у Точняка — четыре ракурса front, right, back, left;
//   у остальных — 12 кадров поворота 01.webp … 12.webp и front.webp для превью.

export const DEFAULT_CHARACTER = 'tochnyak';

export const CHARACTER_PRICE = 50;
export const SKIN_PRICES = [0, 30, 70, 150]; // образ 1 входит в покупку персонажа
const RARITY = ['Обычный', 'Редкий', 'Эпический', 'Легендарный'];
const SKIN_NAMES = {
  betty: ['Розовый вайб', 'Голубой бантик', 'Белая классика', 'Чёрный вечер'],
  luder: ['Карго', 'Красный спорт', 'Варсити', 'Босс'],
  farter: ['Хаки', 'Фиолет', 'Белый люкс', 'Золото']
};

export const CHARACTERS = [
  { id: 'tochnyak', name: 'Точняк', price: 0, skins: [{ id: 'tochnyak', tier: 1, name: 'Классика', rarity: 'Базовый', frames: 4, price: 0 }] },
  ...[['betty', 'Бэтти'], ['luder', 'Лудер'], ['farter', 'Фартер']].map(([id, name]) => ({
    id,
    name,
    price: CHARACTER_PRICE,
    skins: SKIN_PRICES.map((price, k) => ({
      id: `${id}_${k + 1}`,
      tier: k + 1,
      name: SKIN_NAMES[id][k],
      rarity: RARITY[k],
      frames: 12,
      // Первый образ стоит как персонаж: его покупка и есть покупка персонажа.
      price: k === 0 ? CHARACTER_PRICE : price
    }))
  }))
];

const SKINS = new Map();
for (const c of CHARACTERS) for (const s of c.skins) SKINS.set(s.id, { ...s, character: c.id, characterName: c.name });

// Образ по id (старое поле users.character хранит id выбранного образа).
export const skinById = (id) => SKINS.get(id) || null;
export const characterById = skinById;
export const baseSkinOf = (characterId) => {
  const c = CHARACTERS.find((x) => x.id === characterId);
  return c ? c.skins[0].id : null;
};
