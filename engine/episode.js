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

// ── Слова строки — только из её цитаты (владелец и редактор, 11.11 09:05) ────
// 1) Каждое слово роли и значения есть в цитате-источнике этой строки как отдельное слово
//    (сопоставление без учёта регистра и е/ё; пунктуация и пробелы не считаются; слово с дефисом — одно слово).
//    На экран идёт форма, набранная рассказчиком.
// 2) Слово нельзя оторвать от признака, который меняет смысл, — и нельзя приставить признак к чужому слову:
//    - «не», «ни», «буду», «будет»… относятся к следующему слову, в том числе через предлог и «прозрачные» слова
//      («не на работе», «не очень любила»). Цитату нельзя начать сразу после такого признака в рассказе;
//    - условие, сослагательность, неуверенность и чужие слова («если», «бы», «ли», «вроде», «якобы»,
//      «сказал: …») действуют на всю фразу рассказа, где стоит цитата: слова такой фразы берутся только
//      в поле строки, где этот признак тоже есть;
//    - если слово встречается в цитате и с признаком, и без него, строка его не берёт: сократите цитату.
// 3) Роль — одно-два слова. Часть речи не проверяется.

/** Признаки, которые относятся к следующему слову. */
const NEXT_MARKERS = new Set(['не', 'ни', 'буду', 'будешь', 'будет', 'будем', 'будете', 'будут']);
/** Признаки всей фразы: условие, сослагательность, неуверенность, чужие слова. */
const SENTENCE_MARKERS = new Set([
  'если', 'бы', 'б', 'ли', 'якобы', 'будто', 'словно', 'мол', 'дескать', 'чтобы', 'чтоб',
  'вроде', 'вряд', 'кажется', 'наверное', 'возможно', 'типа',
]);
/** Глаголы чужой речи: во фразе с двоеточием или кавычками после них — признак авторства. */
const SPEECH = /^(написал|написала|написали|сказал|сказала|сказали|спросил|спросила|ответил|ответила|пишет|говорит|говорят)$/;
/** Слова, через которые признак продолжает действовать: «не очень любила», «не на работе». */
const TRANSPARENT = new Set([
  'очень', 'совсем', 'особо', 'особенно', 'слишком', 'так', 'сильно', 'вообще', 'всегда', 'сразу',
  'еще', 'уже', 'больше', 'долго', 'часто', 'много', 'до', 'конца',
  'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'за', 'у', 'о', 'об', 'от', 'из', 'без', 'для', 'про', 'над', 'под', 'при',
]);
const isMarker = (w) => NEXT_MARKERS.has(w) || SENTENCE_MARKERS.has(w);
/** Латинские буквы, похожие на русские, внутри русского слова («нe» с латинской e). */
const HOMO = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };

/** Слова текста в сравнимой форме: регистр, ё, пунктуация — как у normalize; «всё-таки» — одно слово. */
export function wordsOf(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/([a-zа-я])-(?=[a-zа-я])/g, '$1‑');
  return normalize(t).split(' ').filter(Boolean)
    .map((w) => (/[а-я]/.test(w) ? w.replace(/[aeopcxykmthb]/g, (c) => HOMO[c]) : w));
}

/** Фразы текста (до . ! ? … ; и перевода строки), каждая — { words, marks }: marks — признаки всей фразы. */
function sentencesOf(text) {
  return String(text || '').split(/[.!?…;\n]+/).map((raw) => {
    const words = wordsOf(raw);
    const marks = new Set(words.filter((w) => SENTENCE_MARKERS.has(w)));
    const speech = words.find((w) => SPEECH.test(w));
    if (speech && /[:«»"“”„]/.test(raw)) marks.add(`речь:${speech}`);
    return { words, marks };
  }).filter((x) => x.words.length);
}

/** Подпись слова: признаки «не/ни/буду…» перед ним (через прозрачные слова). Без признака — ''. */
function preSig(tokens, i) {
  const run = [];
  for (let j = i - 1; j >= 0 && (NEXT_MARKERS.has(tokens[j]) || TRANSPARENT.has(tokens[j])); j--) run.unshift(tokens[j]);
  while (run.length && !NEXT_MARKERS.has(run[0])) run.shift();
  return run.join(' ');
}

/** Все вхождения цитаты в рассказ по границам слов: [{ cut, marks }] — cut: цитата начинается сразу после признака. */
function quoteContext(source, story) {
  const src = wordsOf(source);
  const sents = sentencesOf(story);
  const toks = [], sid = [];
  sents.forEach((s, k) => s.words.forEach((w) => { toks.push(w); sid.push(k); }));
  const out = [];
  for (let s = 0; s + src.length <= toks.length; s++) {
    if (!src.every((w, k) => toks[s + k] === w)) continue;
    let cut = false;
    for (let j = s - 1; j >= 0 && sid[j] === sid[s]; j--) {
      if (NEXT_MARKERS.has(toks[j])) { cut = true; break; }
      if (!TRANSPARENT.has(toks[j])) break;
    }
    const marks = new Set();
    for (let k = sid[s]; k <= sid[s + src.length - 1]; k++) sents[k].marks.forEach((m) => marks.add(m));
    out.push({ cut, marks });
  }
  return out;
}

/** Цитата есть в рассказе как последовательность целых слов (а не кусок слова). */
export function sourceFoundWhole(source, story) {
  return wordsOf(source).length > 0 && quoteContext(source, story).length > 0;
}

/**
 * Ошибки слов строки относительно её цитаты: [{ field: 'role'|'value'|'source', kind, words }].
 * kind: missing — слова нет в цитате; bound — слово оторвано от признака или признак приставлен;
 * ambiguous — слово стоит в цитате и с признаком, и без; empty — в поле нет слов; long — роль длиннее двух слов;
 * cut — цитата в рассказе начинается сразу после «не»/«ни»/«буду»…; partial — цитата в рассказе только кусками слов.
 * story — рассказ: признаки всей фразы берутся из фразы рассказа, где стоит цитата. Без рассказа — из самой цитаты.
 * Пустой source здесь не проверяется — об этом своя ошибка в validateEpisode.
 */
export function rowWordProblems(row, story) {
  const src = wordsOf(row && row.source);
  if (!src.length) return [];
  const problems = [];
  let srcMarks = new Set();
  const hasStory = typeof story === 'string' && story.trim() !== '';
  const ctx = hasStory ? quoteContext(row.source, story) : [];
  // цитата есть в рассказе, но не целыми словами («е пила чай» из «не пила чай»): строка не годится
  if (hasStory && !ctx.length && sourceFound(row.source, story)) problems.push({ field: 'source', kind: 'partial', words: [] });
  if (ctx.length) {
    ctx.forEach((c) => c.marks.forEach((m) => srcMarks.add(m)));
    if (ctx.some((c) => c.cut)) problems.push({ field: 'source', kind: 'cut', words: [] });
  } else {
    sentencesOf(row.source).forEach((x) => x.marks.forEach((m) => srcMarks.add(m)));
  }
  const srcSet = new Set(src);
  const sigs = new Map(); // слово → подписи его вхождений в цитате
  src.forEach((w, i) => { if (!isMarker(w)) (sigs.get(w) || sigs.set(w, new Set()).get(w)).add(preSig(src, i)); });
  const key = (set) => [...set].sort().join(' ');
  // Признаки всей фразы (условие, «бы», чужие слова…) должны быть в строке — в роли или в значении:
  // строка читается целиком, «Рано — я бы ушла» сохраняет сослагательность.
  const rowMarks = new Set();
  for (const f of ['role', 'value']) {
    const t = String((row && row[f]) || '');
    sentencesOf(t).forEach((x) => x.marks.forEach((m) => rowMarks.add(m)));
    wordsOf(t).filter((w) => SPEECH.test(w) && srcMarks.has(`речь:${w}`)).forEach((w) => rowMarks.add(`речь:${w}`));
  }
  const marksOk = key(rowMarks) === key(srcMarks);
  for (const fieldName of ['role', 'value']) {
    const rawText = String((row && row[fieldName]) || '');
    if (!rawText.trim()) continue;
    const words = wordsOf(rawText);
    if (!words.length || words.every(isMarker)) { problems.push({ field: fieldName, kind: 'empty', words: [] }); continue; }
    if (fieldName === 'role' && words.length > 2) problems.push({ field: fieldName, kind: 'long', words: [] });
    const missing = words.filter((w) => !srcSet.has(w));
    if (missing.length) { problems.push({ field: fieldName, kind: 'missing', words: [...new Set(missing)] }); continue; }
    if (!marksOk) {
      problems.push({ field: fieldName, kind: 'bound', words: [words.find((w) => !isMarker(w))] });
      continue;
    }
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (isMarker(w)) continue;
      const own = sigs.get(w);
      if (own.size > 1) { problems.push({ field: fieldName, kind: 'ambiguous', words: [w] }); break; }
      if (!own.has(preSig(words, i))) { problems.push({ field: fieldName, kind: 'bound', words: [w] }); break; }
    }
  }
  return problems;
}

/** Строка годится для титров по словам: роль и значение — из её цитаты, признаки не оторваны. */
export function rowWordsGrounded(row, story) {
  return wordsOf(row && row.source).length > 0 && String(row.role || '').trim() !== '' && String(row.value || '').trim() !== ''
    && rowWordProblems(row, story).length === 0;
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
export function blankEpisode({ date = todayIso(), mood = 'quiet', period = 'day' } = {}) {
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
    for (const pr of rowWordProblems({ role, value, source: r.source }, hasStory ? story : undefined)) {
      const what = pr.field === 'role' ? 'роли' : 'значения';
      const list = pr.words.map((w) => `«${w}»`).join(', ');
      const msg = {
        missing: `Строка ${i + 1}: в цитате нет ${pr.words.length > 1 ? 'слов' : 'слова'} ${list} из ${what}. Слова строки — только из цитаты, в той форме, как человек их сказал.`,
        bound: `Строка ${i + 1}: слово ${list} из ${what} стоит в рассказе с другим служебным словом («не», «бы», «если», чужие слова…). Без него или с лишним смысл меняется.`,
        ambiguous: `Строка ${i + 1}: слово ${list} стоит в цитате и с «не», и без него. Сократите цитату до той части, откуда взята строка.`,
        empty: `Строка ${i + 1}: в поле ${what} нет слов из цитаты.`,
        long: `Строка ${i + 1}: роль — одно-два слова из цитаты.`,
        cut: `Строка ${i + 1}: цитата начинается сразу после «не» или похожего слова. Возьмите цитату вместе с ним.`,
        partial: `Строка ${i + 1}: цитата начинается или кончается посреди слова.`,
      }[pr.kind];
      errors.push(field(`${p}.${pr.field}`, msg));
    }
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
  ep.genre = clip(input?.genre, 60); // пустой жанр — по итоговому mood ниже, а не жанр из blankEpisode
  ep.lead = clip(ep.lead || 'ты', 24) || 'ты';
  // Пустой или неизвестный mood — quiet (редактор повествования, 9.11): нейтральное настроение, без навязанной теплоты.
  ep.mood = Object.hasOwn(MOODS, input?.mood ?? '') ? input.mood : 'quiet';
  ep.music = Object.hasOwn(TRACKS, input?.music ?? '') ? input.music : ep.mood;
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
