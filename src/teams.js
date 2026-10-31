// Нормальные названия клубов. football-data.org отдаёт короткие и местами сленговые
// (Atleti, Barça, Spurs, Man United), поэтому показываем привычные полные.
// Ключ — короткое название от football-data (без учёта регистра), значение — что показать.

const NAMES = {
  // АПЛ
  'man city': 'Manchester City',
  'man united': 'Manchester United',
  'spurs': 'Tottenham',
  'brighton hove': 'Brighton',
  'nottingham': 'Nottingham Forest',
  'wolverhampton': 'Wolves',
  'newcastle': 'Newcastle United',
  'west ham': 'West Ham United',
  'leicester': 'Leicester City',
  'leeds': 'Leeds United',
  // Ла Лига
  'atleti': 'Atlético Madrid',
  'barça': 'Barcelona',
  'barca': 'Barcelona',
  'athletic': 'Athletic Bilbao',
  'celta': 'Celta Vigo',
  'sevilla fc': 'Sevilla',
  'betis': 'Real Betis',
  'rayo': 'Rayo Vallecano',
  'alavés': 'Alavés',
  // Серия А
  'inter': 'Inter Milan',
  'milan': 'AC Milan',
  'verona': 'Hellas Verona',
  'como 1907': 'Como',
  // Бундеслига
  'bayern': 'Bayern Munich',
  'dortmund': 'Borussia Dortmund',
  'leverkusen': 'Bayer Leverkusen',
  "m'gladbach": "Borussia M'gladbach",
  'frankfurt': 'Eintracht Frankfurt',
  'stuttgart': 'VfB Stuttgart',
  'freiburg': 'SC Freiburg',
  'wolfsburg': 'VfL Wolfsburg',
  'bremen': 'Werder Bremen',
  'mainz': 'Mainz 05',
  'augsburg': 'FC Augsburg',
  'köln': '1. FC Köln',
  'koln': '1. FC Köln',
  'hsv': 'Hamburger SV',
  'schalke': 'Schalke 04',
  'bochum': 'VfL Bochum',
  'kiel': 'Holstein Kiel',
  // Лига 1
  'psg': 'Paris Saint-Germain',
  'rennes': 'Stade Rennais',
  'brest': 'Stade Brestois',
  // Эредивизи и Лига чемпионов
  'az': 'AZ Alkmaar',
  'twente': 'FC Twente',
  'utrecht': 'FC Utrecht',
  'porto': 'FC Porto',
  'sporting cp': 'Sporting CP',
  'shakhtar': 'Shakhtar Donetsk',
  'salzburg': 'RB Salzburg',
  'crvena zvezda': 'Crvena Zvezda',
  'young boys': 'Young Boys',
  'sparta praha': 'Sparta Prague',
  'slavia praha': 'Slavia Prague',
  'dinamo zagreb': 'Dinamo Zagreb'
};

// Если короткого нет — чистим полное название от «FC», «CF», «AFC» и т. п.
const SUFFIXES = /\s+(FC|CF|AFC|SC|SSC|AC|CFC|FK|SK|BC)$/i;
const PREFIXES = /^(FC|AFC|SSC|AS|AC|SS|US|ACF|RC|RCD|CA|CD|UD|SD|SC|VfB|VfL|TSG|1\. FC)\s+/i;

export function teamName(short, full) {
  const s = String(short || '').trim();
  const mapped = NAMES[s.toLowerCase()];
  if (mapped) return mapped;
  if (s) return s;
  let f = String(full || '').trim();
  f = f.replace(SUFFIXES, '').replace(PREFIXES, '').trim();
  return f || 'Команда';
}
