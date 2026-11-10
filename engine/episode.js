// Модель эпизода «Титров»: грамматика титров, проверки бережности и привязки к рассказу.
// Чистый модуль без зависимостей: работает в браузере (монтажная) и в Node (бот, рендер, тесты).

export const MOODS = {
  warm:  { id: 'warm',  film: 'Янтарь',    accent: '#DCB68C', genre: 'тёплая драма' },
  sad:   { id: 'sad',   film: 'Сумерки',   accent: '#B4C3D5', genre: 'тихая драма' },
  anger: { id: 'anger', film: 'Терракота', accent: '#E3AD98', genre: 'драма без развязки' },
  quiet: { id: 'quiet', film: 'Шалфей',    accent: '#C4C5BA', genre: 'камерное кино' },
};

export const TRACKS = {
  warm:  { id: 'warm',  title: 'Мягкий свет',            file: 'warm.wav' },
  sad:   { id: 'sad',   title: 'Можно погрустить',       file: 'sad.wav' },
  anger: { id: 'anger', title: 'Собраться и отпустить',  file: 'anger.wav' },
  quiet: { id: 'quiet', title: 'Оставить воздух',        file: 'quiet.wav' },
  none:  { id: 'none',  title: 'тишина',                 file: null },
};

export const TONES = ['quiet', 'direct', 'humor'];
export const PERIODS = { day: 'титры дня', year: 'титры года' };

export const LIMITS = {
  title: 48, genre: 32, role: 20, roleSoft: 16, value: 64, valueSoft: 48, post: 72,
  rowsMin: 2, rowsMax: 6,
};

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2026-11-02» → «2 ноября»; для периода «год» → «2026 год». */
export function dateLabel(isoDate, period = 'day') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return '';
  if (period === 'year') return `${m[1]} год`;
  return `${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]}`;
}

export function todayIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Нормализация для сверки цитат: регистр, ё, пунктуация, пробелы. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'’`.,!?…:;()\[\]—–\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceFound(source, story) {
  const s = normalize(source);
  if (!s) return false;
  return normalize(story).includes(s);
}

/**
 * Род говорящего определяем только по его собственным словам от первого лица
 * («я устала» / «я долго правил»). По имени и по чужим репликам не угадываем никогда.
 * Возвращает 'f', 'm' или null (неизвестно либо противоречиво).
 */
/**
 * Убрать чужую речь, чтобы она не влияла на род рассказчика:
 * фрагменты в кавычках («…», „…“, "…", “…”) и реплику после «написал(а)/сказал(а)/…:» до конца фразы.
 * Незакрытая кавычка срезает текст до конца: при неясной границе реплики род остаётся неизвестным.
 * Это только для определения рода — смысл рассказа и цитаты-источники не трогаются.
 */
export function stripReportedSpeech(story) {
  let t = String(story || '');
  t = t.replace(/«[^»]*(»|$)/g, ' ').replace(/„[^“”]*([“”]|$)/g, ' ').replace(/“[^”]*(”|$)/g, ' ').replace(/"[^"]*("|$)/g, ' ');
  t = t.replace(/(написал|написала|сказал|сказала|спросил|спросила|ответил|ответила|пишет|говорит|сказали|написали)\s*:\s*[^.!?…\n]*/gi, ' ');
  return t;
}

export function detectGender(story) {
  const words = normalize(stripReportedSpeech(story)).split(' ');
  let f = 0, m = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'я') continue;
    for (let j = i + 1; j <= i + 3 && j < words.length; j++) {
      const w = words[j];
      if (w === 'я' || w.length < 3) continue;
      if (/[аеиоуыэюя]л(а|ась)$/.test(w)) { f++; break; }
      if (/[аеиоуыэюя]л(ся)?$/.test(w)) { m++; break; }
    }
  }
  if (f && !m) return 'f';
  if (m && !f) return 'm';
  return null;
}

/** Создать пустой эпизод с разумными умолчаниями. */
export function blankEpisode({ date = todayIso(), mood = 'warm', period = 'day' } = {}) {
  return {
    version: 1,
    period,
    date,
    title: '',
    genre: MOODS[mood].genre,
    mood,
    music: mood,
    lead: 'ты',
    gender: null,
    rows: [],
    post: { text: '', source: '' },
  };
}

/** Строки, которые реально выводятся в титрах: «в главной роли», строки рассказа, саундтрек. */
export function creditRows(ep) {
  const out = [{ role: 'в главной роли', value: ep.lead || 'ты', fixed: true }];
  for (const r of ep.rows || []) {
    if (String(r.role || '').trim() || String(r.value || '').trim()) {
      out.push({ role: String(r.role || '').trim(), value: String(r.value || '').trim() });
    }
  }
  const track = TRACKS[ep.music] || TRACKS.none;
  out.push({ role: 'саундтрек', value: track.file ? `«${track.title}»` : 'тишина', fixed: true });
  return out;
}

const SECOND_PERSON_PAST = /(^|\s)ты\s+(?:[а-яё-]+\s+){0,2}?[а-яё]+[аеиоуыэюя]л(а|о|ся|ась)?(?=\s|$|[.,!?…])/i;
const BANNED_ENDINGS = [
  { re: /финал/i, msg: 'Слово «финал» звучит как конец всего. Используйте «конец сцены» или «до завтра».' },
  { re: /(^|[^а-яё])конец(?!\s+сцены)/i, msg: '«Конец» без слова «сцены» может прочитаться как конец всего.' },
];
const FORCED_POSITIVE = [
  /стал[аио]?\s+сильнее/i, /вс[её]\s+будет\s+хорошо/i, /отпусти(ть|л|ла)?\s+(боль|прошлое)/i,
  /(полезный|важный|ценный)\s+урок/i, /благодар(ен|на|ность)\s+за/i, /нов(ую|ая)\s+жизнь/i,
];
const OTHERS_MOTIVES = [/специально/i, /нарочно/i, /хотел[аи]?\s+(тебя\s+)?(унизить|сломать|задеть)/i];

/**
 * Проверка эпизода. errors — не даём рендерить, warnings — показываем монтажёру.
 * story — опора: исходный рассказ (и правки, которые человек написал сам).
 * Без опоры эпизод не проходит: нельзя проверить, что строки взяты из слов человека.
 * Вымышленные примеры (examples/) проходят тот же путь — у них есть свой рассказ.
 */
export function validateEpisode(ep, story) {
  const errors = [];
  const warnings = [];
  const field = (path, msg) => ({ path, msg });

  if (!ep || typeof ep !== 'object') return { ok: false, errors: [field('', 'Нет эпизода.')], warnings };
  const hasStory = typeof story === 'string' && story.trim().length > 0;
  if (!hasStory) errors.push(field('story', 'Нет исходного рассказа: без него нельзя проверить, что строки взяты из слов человека.'));
  if (!MOODS[ep.mood]) errors.push(field('mood', 'Неизвестная плёнка.'));
  if (!TRACKS[ep.music]) errors.push(field('music', 'Неизвестный саундтрек.'));
  if (!PERIODS[ep.period]) errors.push(field('period', 'Неизвестный период.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ep.date || '')) errors.push(field('date', 'Дата должна быть в формате ГГГГ-ММ-ДД.'));

  const title = String(ep.title || '').trim();
  if (!title) errors.push(field('title', 'Нужно название эпизода.'));
  else if (title.length > LIMITS.title) errors.push(field('title', `Название длиннее ${LIMITS.title} знаков.`));
  const genre = String(ep.genre || '').trim();
  if (!genre) errors.push(field('genre', 'Нужен жанр.'));
  else if (genre.length > LIMITS.genre) errors.push(field('genre', `Жанр длиннее ${LIMITS.genre} знаков.`));

  const rows = Array.isArray(ep.rows) ? ep.rows : [];
  const filled = rows.filter((r) => String(r.role || '').trim() || String(r.value || '').trim());
  if (filled.length < LIMITS.rowsMin) errors.push(field('rows', `Нужно хотя бы ${LIMITS.rowsMin} строки.`));
  if (filled.length > LIMITS.rowsMax) errors.push(field('rows', `Не больше ${LIMITS.rowsMax} строк: длинные титры не дочитывают.`));

  const texts = [title, genre];
  rows.forEach((r, i) => {
    const p = `rows.${i}`;
    const role = String(r.role || '').trim();
    const value = String(r.value || '').trim();
    if (!role && !value) return;
    if (!role) errors.push(field(`${p}.role`, `Строка ${i + 1}: нет роли.`));
    if (!value) errors.push(field(`${p}.value`, `Строка ${i + 1}: нет текста.`));
    if (role.length > LIMITS.role) errors.push(field(`${p}.role`, `Строка ${i + 1}: роль длиннее ${LIMITS.role} знаков.`));
    else if (role.length > LIMITS.roleSoft) warnings.push(field(`${p}.role`, `Строка ${i + 1}: роль лучше сократить до одного-двух слов.`));
    if (value.length > LIMITS.value) errors.push(field(`${p}.value`, `Строка ${i + 1}: текст длиннее ${LIMITS.value} знаков.`));
    else if (value.length > LIMITS.valueSoft) warnings.push(field(`${p}.value`, `Строка ${i + 1}: длинная строка займёт три линии, лучше сократить.`));
    if (!String(r.source || '').trim()) errors.push(field(`${p}.source`, `Строка ${i + 1}: нет цитаты из рассказа. В титрах только то, что человек сказал сам.`));
    else if (hasStory && !sourceFound(r.source, story)) errors.push(field(`${p}.source`, `Строка ${i + 1}: цитата не найдена в рассказе. В титрах только то, что человек сказал сам.`));
    texts.push(role, value);
  });

  const post = ep.post || {};
  const postText = String(post.text || '').trim();
  if (postText.length > LIMITS.post) errors.push(field('post.text', `Сцена после титров длиннее ${LIMITS.post} знаков.`));
  if (postText && !String(post.source || '').trim()) {
    errors.push(field('post.source', 'У сцены после титров нет цитаты из рассказа.'));
  } else if (postText && hasStory && !sourceFound(post.source, story)) {
    errors.push(field('post.source', 'Цитата для сцены после титров не найдена в рассказе.'));
  }
  texts.push(postText);

  const all = texts.join(' \n ');
  if (!ep.gender && SECOND_PERSON_PAST.test(all)) {
    warnings.push(field('gender', 'Есть глагол прошедшего времени на «ты», а род неизвестен. Перепишите именной фразой («Письмо — отправлено») или укажите род со слов человека.'));
  }
  for (const b of BANNED_ENDINGS) if (b.re.test(all)) warnings.push(field('text', b.msg));
  if (FORCED_POSITIVE.some((re) => re.test(all))) warnings.push(field('text', 'Похоже на навязанный позитив или мораль. Титры не делают вывод за человека.'));
  if (OTHERS_MOTIVES.some((re) => re.test(all))) warnings.push(field('text', 'Строка приписывает мотивы другим людям. Оставьте только то, что произошло и что человек почувствовал.'));

  return { ok: errors.length === 0, errors, warnings };
}

/** Привести входные данные (из формы, модели или JSON) к аккуратному эпизоду. */
export function sanitizeEpisode(input) {
  const base = blankEpisode();
  const ep = { ...base, ...(input || {}) };
  const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  ep.title = clip(ep.title, 80);
  ep.genre = clip(input?.genre, 60); // пустой жанр — по итоговому mood ниже, а не «тёплая драма» из blankEpisode
  ep.lead = clip(ep.lead || 'ты', 24) || 'ты';
  // Пустой или неизвестный mood — quiet (редактор повествования, 9.11): нейтральное настроение, без навязанной теплоты.
  ep.mood = MOODS[input?.mood] ? input.mood : 'quiet';
  ep.music = TRACKS[input?.music] ? input.music : ep.mood;
  if (!ep.genre) ep.genre = MOODS[ep.mood].genre;
  ep.period = PERIODS[ep.period] ? ep.period : 'day';
  ep.gender = ep.gender === 'f' || ep.gender === 'm' ? ep.gender : null;
  ep.rows = (Array.isArray(ep.rows) ? ep.rows : []).slice(0, 10).map((r) => ({
    role: clip(r && r.role, 40), value: clip(r && r.value, 120), source: clip(r && r.source, 400),
  }));
  ep.post = { text: clip(ep.post && ep.post.text, 120), source: clip(ep.post && ep.post.source, 400) };
  return ep;
}

/** Текстовая версия титров: для чата, доступности и полной текстовой версии плеера. */
export function episodeToText(ep) {
  const lines = [];
  lines.push(`${PERIODS[ep.period] || 'титры'} · ${dateLabel(ep.date, ep.period)}`.toUpperCase());
  lines.push(`«${ep.title}»`);
  lines.push(`жанр: ${ep.genre}`);
  lines.push('');
  creditRows(ep).forEach((r) => lines.push(`${r.role} — ${r.value}`));
  lines.push('');
  lines.push('Конец сцены.');
  if (ep.post && ep.post.text) lines.push(`После титров: ${ep.post.text}`);
  return lines.join('\n');
}
