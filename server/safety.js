// Нижняя граница безопасности. Это не диагностика и не надёжное обнаружение риска:
// фильтр ловит прямые формулировки, второй слой — флаг safety_flag от модели в draft.js.
// Если сработал любой слой, ролик не делается: вместо титров человек видит спокойный экран помощи.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const URGENT = [
  /не\s+хочу\s+(больше\s+)?жить/,
  /не\s+хочется\s+(больше\s+)?жить/,
  /хочу\s+умереть/,
  /хочется\s+умереть/,
  /(покончить|кончать|покончу)\s+с\s+собой/,
  /суицид/,
  /самоубий/,
  /уб(ить|ью)\s+себя/,
  /св(ести|еду)\s+сч[её]ты\s+с\s+жизнью/,
  /уйти\s+из\s+жизни/,
  /лучше\s+бы\s+меня\s+не\s+было/,
  /(всем|никому)\s+будет\s+лучше\s+без\s+меня/,
  /нет\s+смысла\s+жить/,
  /(режу|порезала?|резать)\s+себя/,
  /селфхарм|самоповрежд/,
  /наглотаться\s+таблеток/,
  /выпилиться/,
  /прыгнуть\s+с\s+(крыши|моста)/,
  /попрощаться\s+со\s+всеми\s+навсегда/,
  // Прямая опасность для самого человека (база: «опасность» — ролик не делается).
  /мне\s+угрожа/,
  /боюсь\s+за\s+свою\s+жизнь/,
  /меня\s+(?:бьет|бьют)(?!\s+(?:дрожь|озноб|током|ток|колотун|мандраж))/,
  /меня\s+(?:избил|избила|избили|избивает|избивают|ударил|ударила|ударили|душил|душила)/,
];

// Гнев на других — частая гипербола («убью его, если опоздает»): ролик собирается, рядом — контакты помощи.
const CONCERN = [
  /(убью|прибью|убить\s+готова?)\s+(его|е[её]|их|тебя)/,
];

function norm(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/**
 * Оценка рассказа. level: 'none' | 'concern' | 'urgent'.
 * modelFlag — необязательный флаг от модели черновика (второй слой).
 */
export function assessRisk(text, modelFlag = false) {
  const t = norm(text);
  const urgent = URGENT.filter((re) => re.test(t)).map(String);
  if (urgent.length || modelFlag) return { level: 'urgent', matches: urgent, byModel: !!modelFlag && !urgent.length };
  const concern = CONCERN.filter((re) => re.test(t)).map(String);
  if (concern.length) return { level: 'concern', matches: concern, byModel: false };
  return { level: 'none', matches: [], byModel: false };
}

/**
 * Проверка перед рендером: рассказ и все тексты эпизода вместе.
 * Правки после черновика тоже проверяются — опасная строка не попадёт в ролик.
 */
export function assessEpisodeRisk(story, ep) {
  const parts = [story];
  if (ep) {
    parts.push(ep.title, ep.genre, ep.lead);
    for (const r of ep.rows || []) parts.push(r.role, r.value);
    if (ep.post) parts.push(ep.post.text);
  }
  return assessRisk(parts.filter(Boolean).join('\n'));
}

export function loadHelp(file = path.join(here, '..', 'config', 'help.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const contacts = [cfg.emergency, ...(cfg.contacts || [])].filter((c) => c && c.verified && c.phone);
  return { region: cfg.region, contacts };
}

/** Текст экрана помощи. Без обещаний «мы всегда заметим» и без давления. */
export function helpMessage(level, help = loadHelp()) {
  const list = help.contacts.map((c) => `• ${c.label}: ${c.phone}${c.hours ? ` (${c.hours})` : ''}`).join('\n');
  if (level === 'urgent') {
    return [
      'Сейчас важнее не титры, а ты.',
      'В рассказе есть слова о том, что жить не хочется или есть опасность. Я не буду делать из этого ролик.',
      'Если есть риск прямо сейчас, позвони по одному из номеров или попроси кого-то рядом побыть с тобой:',
      list,
      'Когда захочется, можно прислать новый рассказ о дне.',
    ].join('\n\n');
  }
  return [
    'Похоже, в этом дне было что-то опасное или очень тяжёлое.',
    'Если тебе или кому-то рядом угрожает опасность, лучше обратиться за живой помощью:',
    list,
  ].join('\n\n');
}
