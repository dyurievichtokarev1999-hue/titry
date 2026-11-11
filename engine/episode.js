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
//      («не на работе», «не очень любила»); «не», «ни», «нельзя» — ещё и ко всей части фразы после них
//      («не стала пить чай»: «чай» берётся только в строке с «не»), «не я» — ко всей части фразы.
//      Цитату нельзя начать внутри такой части или сразу после «не» (в том числе через «…» и перевод строки);
//    - условие, сослагательность, неуверенность и чужие слова («если», «бы», «ли», «вроде», «якобы»,
//      «сказал: …») действуют на всю фразу рассказа, где стоит цитата: слова такой фразы берутся только
//      в поле строки, где этот признак тоже есть;
//    - если слово встречается в цитате и с признаком, и без него, строка его не берёт: сократите цитату.
// 3) Роль — одно-два слова. Часть речи не проверяется.

/** Местоимения после «не» не забирают отрицание у глагола: «Не я пила чай» — «пила» только с «не я». */
const PRONOUNS = ['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'мне', 'меня', 'его', 'ее', 'их', 'нам', 'нас'];
/** Признаки, которые относятся к следующему слову. */
const NEXT_MARKERS = new Set(['не', 'ни', 'буду', 'будешь', 'будет', 'будем', 'будете', 'будут',
  'почти', 'едва', 'еле', 'чуть', 'нечего', 'некогда', 'негде', 'некуда', 'незачем', 'некому']);
/**
 * Бросание и намерение действуют до конца части фразы, как «не»: «бросила курить», «хотела уйти и хлопнуть дверью».
 * Слова после них берутся только в строке с самим глаголом.
 */
const INTENT = /^(брос(ил|ила|или|ить|аю|ает)|переста(л|ла|ли|ть|ю|ет)|прекрати(л|ла|ли|ть)|хоте(л|ла|ли|ть|лось)|хоч(у|ет|ешь)|хотим|хочется|мечта(л|ла|ли|ю|ет)|собира(л|ла|лась|лся|юсь|ется|лись)|планир(ую|ует|овал|овала)|пыта(л|ла|лась|лся|юсь|ется)|попыта(лась|лся)|постара(лась|лся|юсь)|намерен(а)?|решил(а|и)?|отказал(ась|ся)|захоте(л|ла|ли)|обеща(л|ла|ли|ю)|забы(л|ла|ли)|долж(на|ен|ны|но))$/;
/** «думала поехать»: глагол мысли или возможности с инфинитивом после него — тоже намерение. */
const INTENT_INF = /^(дума(л|ла|ли|ю)|подума(л|ла)|смог(у|ла|ли)?|сможе(т|шь|м|те)|смогут|мог(у|ла|ли)?|може(т|шь|м|те)|могут)$/;
const INFINITIVE = /(ть|ться|тись|ти|чь)$/;
const isNext = (w) => NEXT_MARKERS.has(w);
/**
 * Признаки всей фразы: условие, сослагательность, отрицание «нет», «почти», неуверенность, сон,
 * чужие слова и мысли («сказала, что…», «говорят», «по словам», «думала», «показалось», «видимо»).
 * Слова такой фразы берутся в строку только вместе с признаком (в роли или в значении).
 */
const SENTENCE_MARKERS = new Set([
  'если', 'бы', 'б', 'ли', 'якобы', 'будто', 'словно', 'мол', 'дескать', 'чтобы', 'чтоб',
  'нет', 'нету', 'почти', 'едва', 'еле', 'чуть',
  'вроде', 'вряд', 'кажется', 'казалось', 'показалось', 'наверное', 'наверно', 'возможно', 'может', 'типа',
  'видимо', 'похоже', 'по\u2011моему', 'по\u2011видимому', 'уверена', 'уверен', 'надеюсь', 'надеялась', 'надеялся',
  'снилось', 'приснилось', 'снился', 'снилась', 'приснился', 'приснилась', 'снится', 'снятся', 'сне', 'сон', 'сна',
  'говорят', 'говорили', 'словам', 'вероятно', 'пожалуй', 'наверняка', 'думают', 'считают', 'мерещится', 'померещилось',
  'кажись', 'небось', 'видать', 'полагаю', 'полагала', 'полагал', 'скорее', 'почудилось', 'привиделось', 'мерещилось', 'чудится',
]);
/**
 * Глаголы речи, мысли и восприятия: признак, когда за ними идёт чужое или предполагаемое содержание —
 * «что…», двоеточие или кавычки («Мама сказала, что я опоздала»). «Написал черновик» — не признак.
 */
const REPORT_VERBS = new Set([
  'думала', 'думал', 'думаю', 'подумала', 'подумал', 'считаю', 'считала', 'считал', 'считает', 'знаю',
  'написал', 'написала', 'написали', 'пишет', 'пишут', 'сказал', 'сказала', 'сказали', 'говорит', 'говорила', 'говорил',
  'спросил', 'спросила', 'ответил', 'ответила', 'обещал', 'обещала', 'слышала', 'слышал', 'решила', 'решил', 'боюсь',
  'помню', 'орал', 'орала', 'кричал', 'кричала', 'заявил', 'заявила', 'сообщил', 'сообщила', 'объяснил', 'объяснила',
]);
/** Отрицание действует до конца части фразы (до знака препинания): «не стала пить чай» — «чай» тоже под «не». */
const NEG = new Set(['не', 'ни', 'нельзя']);
/** Признаки-служебные слова: строка из одних них пуста. Глаголы речи и «нет» — сами по себе слова. */
const FUNCTION_MARKERS = new Set(['не', 'ни', 'нельзя', 'почти', 'едва', 'еле', 'чуть', 'если', 'бы', 'б', 'ли', 'якобы', 'будто', 'словно', 'мол', 'дескать', 'чтобы', 'чтоб',
  'вряд', 'типа', 'может', 'буду', 'будешь', 'будет', 'будем', 'будете', 'будут']);
/** Признаки из двух слов: «по моему» (без дефиса). */
const SENTENCE_BIGRAMS = [['по', 'моему'], ['по', 'видимому'], ['должно', 'быть']];
/** Слова, через которые признак продолжает действовать: «не очень любила», «не на работе». */
const TRANSPARENT = new Set([
  'очень', 'совсем', 'особо', 'особенно', 'слишком', 'так', 'сильно', 'вообще', 'всегда', 'сразу',
  'еще', 'уже', 'больше', 'долго', 'часто', 'много', 'до', 'конца',
  'весь', 'вся', 'всю', 'все', 'всех', 'всем', 'целый', 'целую', 'целая', 'два', 'две', 'три', 'пять', 'десять', 'сто',
  'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'за', 'у', 'о', 'об', 'от', 'из', 'для', 'про', 'над', 'под', 'при',
  ...PRONOUNS,
]);
/** Служебное слово-признак («не», «почти», «хотела», «снится», «сказала»…): ролью и краем значения быть не может. */
export const isMarkerWord = (w) => isMarker(String(w || '').toLowerCase().replace(/ё/g, 'е'));
const isMarker = (w) => isNext(w) || INTENT.test(w) || SENTENCE_MARKERS.has(w) || REPORT_VERBS.has(w) || NEG.has(w);
/** Глаголы речи, мысли и мнения по основе: признак, если после них «что», знак или подлежащее-местоимение. */
const REPORT_STEM = /^(сказ|говор|писа|напис|пиш|дума|подума|счита|увер|сообщ|объясн|крич|орал|ора|заяв|обеща|утвержд|слыш|помн|зна[юел]|ответ|спрос|рассказ|жалова|намек|орет|ворч|тверд|шепч|шепт|бормоч|бормот|повтор|называ|назвал|обзыва|обозвал|визж|упрека|упрекн)/;
/** Глагольные окончания: «ответил» — глагол, «ответа» — нет. */
const VERB_END = /(л|ла|ли|ло|лся|лась|лись|ю|ет|ют|ит|ят|ешь|ишь|ем|им|ете|ите|ть|ться|ется|ются|ал|яла|ял)$/;
const SUBJECT = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они']);

/** Латинские буквы, похожие на русские, внутри русского слова («нe» с латинской e). */
const HOMO = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };

/** Слова текста в сравнимой форме: регистр, ё, пунктуация — как у normalize; «всё-таки» — одно слово. */
export function wordsOf(text, homo = true) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/([a-zа-я])-(?=[a-zа-я])/g, '$1\u2011');
  const words = normalize(t).split(' ').filter(Boolean);
  return homo ? words.map((w) => (/[а-я]/.test(w) ? w.replace(/[aeopcxykmthb]/g, (c) => HOMO[c]) : w)) : words;
}

/**
 * Деление на фразы для признаков: граница — «.», «!», «?», «;» и перевод строки, но не многоточие («Кажется... муж…»),
 * не перевод строки после двоеточия («сказала:\nты…») и не знаки внутри кавычек («Ты опоздала. Ты всегда…»).
 */
function splitPhrases(text) {
  // многоточие в любых видах («...», «. . .», «?..», «!..») — не конец фразы
  const t = String(text || '').replace(/\.(\s?\.){1,}/g, '…').replace(/[?!]+…/g, '…');
  // непарная прямая кавычка: при сомнении считаем цитатой всё после первой из них
  const oddPlain = ((t.match(/"/g) || []).length % 2) === 1;
  const out = [];
  let cur = '', plainQuote = false, lockedPlain = false;
  const stack = []; // открытые кавычки: «, „, “
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '«' || c === '„') stack.push(c);
    else if (c === '»') { if (stack.includes('«')) stack.splice(stack.lastIndexOf('«'), 1); }
    else if (c === '“') { if (stack[stack.length - 1] === '„') stack.pop(); else stack.push('“'); }
    else if (c === '”') { if (stack.includes('“')) stack.splice(stack.lastIndexOf('“'), 1); }
    else if (c === '"' && !lockedPlain) { plainQuote = !plainQuote; if (oddPlain && plainQuote) lockedPlain = true; }
    const inQuote = stack.length > 0 || plainQuote;
    // перевод строки — граница, кроме случаев, когда строка обрывается на знаке или признаке («сказала —», «Во сне», «не»)
    const lastWord = c === '\n' ? (wordsOf(cur).at(-1) || '') : '';
    const softBreak = c === '\n' && (/[:—–,\-]\s*$/.test(cur) || isMarker(lastWord) || REPORT_STEM.test(lastWord));
    const boundary = !inQuote && (/[.!?;]/.test(c) || (c === '\n' && !softBreak));
    if (boundary) { out.push(cur); cur = ''; } else cur += c === '\n' ? ' ' : c;
  }
  out.push(cur);
  return out;
}

/** Фразы текста, каждая — { words, marks }: marks — признаки всей фразы. */
function sentencesOf(text, homo = true) {
  return splitPhrases(text).map((raw) => {
    const words = wordsOf(raw, homo);
    const low = raw.toLowerCase().replace(/ё/g, 'е');
    const marks = new Set();
    words.forEach((w, i) => {
      if (!SENTENCE_MARKERS.has(w)) return;
      // слова-связки разговорной речи — не признаки: «если честно», «как бы», «Нет, я не устала»
      if (w === 'если' && words[i + 1] === 'честно') return;
      if ((w === 'бы' || w === 'б') && words[i - 1] === 'как') return;
      if ((w === 'нет' || w === 'нету') && i === 0 && /^\s*нету?\s*,/.test(low)) return;
      marks.add(w);
    });
    // глагол речи, мысли или мнения с содержанием после него: «сказала, что…», «сказала: …», «сказала — …»,
    // «думаю, он…», «сказала я лентяйка» (подлежащее-местоимение после глагола)
    // Позиции знаков считаются один раз на фразу: проверка линейна по длине рассказа.
    const lastMark = Math.max(...['—', '–', ':', '«', '"', '„', '“'].map((c) => low.lastIndexOf(c)));
    const seen = new Set();
    words.forEach((w, i) => {
      if (seen.has(w) || !(REPORT_VERBS.has(w) || (REPORT_STEM.test(w) && VERB_END.test(w)))) return;
      seen.add(w);
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^а-я])${esc}(?![а-я])`, 'g');
      let m, first = -1, after = false;
      while ((m = re.exec(low)) !== null) {
        const end = m.index + m[0].length;
        if (first < 0) first = end;
        // сразу после глагола — знак, «что», «будто», «как»
        if (/^\s*([,:—–«"„“]|что(?![а-я])|будто|как\s)/.test(low.slice(end, end + 12))) { after = true; break; }
      }
      // дальше в той же фразе — тире, двоеточие или кавычки («написала в чате — лентяйка»)
      const later = first >= 0 && lastMark >= first;
      // подлежащее-местоимение сразу после глагола (через «мне/нам…»): «сказала я лентяйка», «сказали мне я уволена»
      const subj = words.some((x, k) => {
        if (x !== w) return false;
        let j = k + 1;
        while (['мне', 'нам', 'ему', 'ей', 'им', 'тебе', 'вам'].includes(words[j])) j++;
        return SUBJECT.has(words[j]);
      });
      if (after || later || subj) marks.add(w);
    });
    // общий признак чужих слов и мнения: «…, что …» и двоеточие после слова (не «7:30», не «:)»)
    if (/,\s*что(\s|$)/.test(low)) marks.add('что');
    // двоеточие — признак чужих слов, кроме времени «7:30» и смайликов «:)»
    if (/:/.test(raw.replace(/\d\s*:\s*\d/g, '').replace(/:-?[)(dDpPоО3]/g, ''))) marks.add(':');
    // в кавычках — чужие слова или название: строка берёт их только в кавычках
    if (/[«»"“”„]/.test(raw)) marks.add('«»');
    for (const [a, b] of SENTENCE_BIGRAMS) if (words.some((w, i) => w === a && words[i + 1] === b)) marks.add(`${a} ${b}`);
    return { words, marks };
  }).filter((x) => x.words.length);
}

/** Слова текста и номер части фразы для каждого (части — до знака препинания). */
function tokensWithClauses(text, homo = true) {
  const toks = [], cl = [];
  // часть, которая начинается с инфинитива, продолжает предыдущую: «хотела позвонить маме, рассказать про работу»
  let id = -1;
  String(text || '').split(/[,;:—–()«»"“”„.!?…\n]+|\s-\s/).forEach((part, k) => {
    const ws = wordsOf(part, homo);
    if (!ws.length) return;
    if (!(k > 0 && id >= 0 && ws[0].length > 3 && INFINITIVE.test(ws[0]))) id++;
    ws.forEach((w) => { toks.push(w); cl.push(id); });
  });
  return { toks, cl };
}

/** Слово, которое действует до конца части фразы: «не/ни/нельзя», «без», намерение («хотела», «думала» + инфинитив). */
function scopeWord(toks, j) {
  const w = toks[j];
  if (NEG.has(w) || w === 'без' || INTENT.test(w)) return true;
  return INTENT_INF.test(w) && INFINITIVE.test(toks[j + 1] || '');
}

/**
 * Какие слова действуют на слово i до конца части фразы: «не стала пить чай» — «чай» под «не»;
 * «без сахара и молока» — «молока» под «без»; «хотела уйти и хлопнуть дверью» — под «хотела».
 * «не я / не он» в той же части — под «не». Возвращает отсортированный список таких слов.
 */
function scopeOf(toks, cl, i) {
  const out = new Set();
  for (let j = 0; j < toks.length; j++) {
    if (cl[j] !== cl[i] || j === i || !scopeWord(toks, j)) continue;
    if (j < i) out.add(toks[j]);
    else if (NEG.has(toks[j]) && PRONOUNS.includes(toks[j + 1]) && cl[j + 1] === cl[i]) out.add(toks[j]); // «Ужин готовила не я»
  }
  return [...out].sort();
}

/** Подпись слова: признаки «не/ни/буду…» перед ним (через прозрачные слова). Без признака — ''. */
function preSig(tokens, i) {
  const run = [];
  for (let j = i - 1; j >= 0 && (isNext(tokens[j]) || TRANSPARENT.has(tokens[j])); j--) run.unshift(tokens[j]);
  while (run.length && !isNext(run[0])) run.shift();
  return run.join(' ');
}

/** Все вхождения цитаты в рассказ по границам слов: [{ cut, marks }] — cut: цитата начинается сразу после признака. */
function quoteContext(source, story) {
  const src = wordsOf(source);
  const sents = sentencesOf(story);
  const toks = [], sid = [];
  sents.forEach((s, k) => s.words.forEach((w) => { toks.push(w); sid.push(k); }));
  const { cl } = tokensWithClauses(story); // те же слова, с номерами частей фразы
  const out = [];
  for (let s = 0; s + src.length <= toks.length; s++) {
    if (!src.every((w, k) => toks[s + k] === w)) continue;
    let cut = false;
    // 1) «буду», «не», «почти» прямо перед цитатой (через прозрачные слова) в той же фразе;
    //    «не» в самом конце предыдущей фразы («Я не. Пила чай.») — тоже обрезка
    for (let j = s - 1; j >= 0; j--) {
      // через границу фразы — только «не», «буду», «почти» (не намерение: «Купила всё, что хотела. Утром…»)
      if (sid[j] !== sid[s] && !(isNext(toks[j]) || NEG.has(toks[j]) || TRANSPARENT.has(toks[j]))) break;
      if (isNext(toks[j]) || NEG.has(toks[j]) || (sid[j] === sid[s] && scopeWord(toks, j))) { cut = true; break; }
      if (!TRANSPARENT.has(toks[j])) break;
    }
    // 2) отрицание, «без» или намерение раньше в той же части фразы: «не стала пить чай» — цитата «пить чай» обрезана
    for (let j = s - 1; !cut && j >= 0 && cl[j] === cl[s]; j--) if (scopeWord(toks, j)) cut = true;
    // 3) «не я» после цитаты в той же части фразы: «Ужин готовила не я»
    for (let j = s + src.length; !cut && j < toks.length && cl[j] === cl[s + src.length - 1]; j++) {
      if (NEG.has(toks[j]) && PRONOUNS.includes(toks[j + 1])) cut = true;
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
    // цитата встречается в рассказе и без обрезки (например, в правке человека) — годится; иначе нет
    if (ctx.every((c) => c.cut)) problems.push({ field: 'source', kind: 'cut', words: [] });
  } else {
    sentencesOf(row.source).forEach((x) => x.marks.forEach((m) => srcMarks.add(m)));
  }
  const srcSet = new Set(src);
  const sigs = new Map(); // слово → подписи его вхождений в цитате
  // подпись проверяется у всех слов, кроме служебных («не», «бы», «если»…): «Написал» из «не написал» — тоже без «не» нельзя
  const plain = (w) => !isNext(w) && !FUNCTION_MARKERS.has(w);
  const { toks: srcT, cl: srcC } = tokensWithClauses(row.source);
  src.forEach((w, i) => { if (plain(w)) (sigs.get(w) || sigs.set(w, new Set()).get(w)).add(`${preSig(src, i)}|${scopeOf(srcT, srcC, i).join(' ')}`); });
  // слова строки, которые в цитате стоят под отрицанием: строка должна содержать «не»/«ни»/«нельзя»
  const rowWords = wordsOf(`${String((row && row.role) || '')} ${String((row && row.value) || '')}`, false);
  const rowSet = new Set(rowWords);
  const key = (set) => [...set].sort().join(' ');
  // Признаки всей фразы (условие, «бы», чужие слова…) должны быть в строке — в роли или в значении:
  // строка читается целиком, «Рано — я бы ушла» сохраняет сослагательность.
  const rowMarks = new Set();
  // роль и значение читаются вместе: «Думала — что он злится» — это «думала, что…»
  // роль и значение разделены «—» на экране; для признаков читаем их как «роль, значение»
  sentencesOf(`${String((row && row.role) || '')}, ${String((row && row.value) || '')}`, false).forEach((x) => x.marks.forEach((m) => rowMarks.add(m)));
  const marksOk = key(rowMarks) === key(srcMarks);
  // «без» и намерение в строке должны относиться к слову, которое и в цитате стоит под ними:
  // «Задачу — решила» из «Решила задачу» — да; «Чай — хотела» из «пила чай и хотела спать» — нет
  const scopedBy = new Set();
  src.forEach((w, i) => { if (plain(w) && rowSet.has(w)) scopeOf(srcT, srcC, i).forEach((x) => scopedBy.add(x)); });
  const orphan = rowWords.find((w) => (w === 'без' || INTENT.test(w)) && !scopedBy.has(w));
  if (orphan) problems.push({ field: wordsOf(String(row.role || ''), false).includes(orphan) ? 'role' : 'value', kind: 'bound', words: [orphan] });
  for (const fieldName of ['role', 'value']) {
    const rawText = String((row && row[fieldName]) || '');
    if (!rawText.trim()) continue;
    // латинские буквы-двойники в самой строке не приводятся: такое слово не совпадёт с цитатой и не попадёт на экран
    const words = wordsOf(rawText, false);
    // «нет», «думала», «снилось» — сами по себе слова («Друзей — нет»); «не», «бы», «если» без слова — пустое поле
    if (!words.length || words.every((w) => FUNCTION_MARKERS.has(w))) { problems.push({ field: fieldName, kind: 'empty', words: [] }); continue; }
    if (fieldName === 'role' && words.length > 2) problems.push({ field: fieldName, kind: 'long', words: [] });
    const missing = words.filter((w) => !srcSet.has(w));
    if (missing.length) { problems.push({ field: fieldName, kind: 'missing', words: [...new Set(missing)] }); continue; }
    if (!marksOk) {
      problems.push({ field: fieldName, kind: 'bound', words: [words.find((w) => !isMarker(w)) || words[0]] });
      continue;
    }
    // «почти», «не», «без», «хотела»… в строке стоят прямо перед своим словом: «Почти — вернулась» не годится
    const dangling = words.findIndex((w, i) => isNext(w) && !(NEG.has(w) && PRONOUNS.includes(words[i + 1])) && !words.slice(i + 1).some((x) => !isNext(x) && !TRANSPARENT.has(x) && !FUNCTION_MARKERS.has(x)));
    if (dangling >= 0) { problems.push({ field: fieldName, kind: 'bound', words: [words[dangling]] }); continue; }
    const { toks: fieldT, cl: fieldC } = tokensWithClauses(rawText, false);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!plain(w)) continue;
      const own = sigs.get(w);
      if (own.size > 1) { problems.push({ field: fieldName, kind: 'ambiguous', words: [w] }); break; }
      const [pre, neg] = [...own][0].split('|');
      // признак нельзя приставить к чужому слову: «Хотела чай», «Пила без — чай»
      const fieldScope = scopeOf(fieldT, fieldC, i).join(' ');
      if (pre !== preSig(words, i) || (neg && !neg.split(' ').every((x) => rowSet.has(x))) || (!neg && fieldScope)) { problems.push({ field: fieldName, kind: 'bound', words: [w] }); break; }
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
      errors.push({ ...field(`${p}.${pr.field}`, msg), kind: `words:${pr.kind}`, row: i, words: pr.words });
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
