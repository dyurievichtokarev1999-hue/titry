// Telegram-бот «Титры»: голосовое или текст → черновик титров → правка → MP4 9:16 в чат.
// Без внешних зависимостей для Telegram: Bot API через fetch, long polling.
// Запуск: TELEGRAM_BOT_TOKEN=... npm run bot
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, LIMITS, creditRows, dateLabel, todayIso, validateEpisode, PERIODS, episodeToText, EDIT_SEP, cleanInput, joinEdits } from '../engine/episode.js';
import { makeDraft, draftRuleBased, modelSafetyCheck, hasClaudeCredentials, pairFromSentence, SAFETY_TIMEOUT_MS, STORY_MAX, TOO_LONG_TEXT } from './draft.js';
import { makeGate, modelModeAtStart, RETRY_DELAY_MS } from './gate.js';
import { startsWithContinuation, modelConcernMessage, helpMessage, tryLaterMessage, NOT_HEARD_TEXT, prepareHelp, assessRisk, assessEpisodeRisk, validateSafeEpisode, threatErrors, threatPronounFilter, INSUFFICIENT_TEXT, INSUFFICIENT_INVITE_TEXT, INSUFFICIENT_AFTER_EXCLUSION, INSUFFICIENT_MATERIAL, EDIT_NOT_IN_TITLES_TEXT, editNotInTitlesText, TELEGRAM_TEXT_LIMIT } from './safety.js';
import { renderEpisode, checkRenderer, ROOT, RENDER_TIMEOUT_MS, KILL_GRACE_MS, renderTimeoutFromEnv, withRenderTimeout, removeQuiet } from './render.js';
import { logError, safeCode, logRenderTimeout } from './errlog.js';
import { transcribeOgg, sttAvailable, MAX_VOICE_SECONDS, cleanupVoiceOrphans } from './stt.js';
import { processLedger, KEY_ENV, KEY_VERSION_ENV } from './ledger.js';
import { makeHealth, writeHealth } from './health.js';
import { CONSENT_TEXT, CONSENT_VERSION, consentSteps } from './consent.js';
import { unfinishedTexts } from './release.js';

const MOOD_ORDER = ['warm', 'sad', 'anger', 'quiet'];
const MUSIC_ORDER = ['warm', 'sad', 'anger', 'quiet', 'none'];
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const WATERMARK = process.env.BOT_WATERMARK ?? 'сделано в титрах';

// Команды бота (setMyCommands). Разбор — parseCommand в createBot: без учёта регистра, «@имя_бота» — только своего бота.
const KNOWN_COMMANDS = new Set(['start', 'year', 'delete', 'help']);
// Значения кнопок отклика под роликом — те же, что в feedbackKeyboard (менять вместе).
const FEEDBACK_VALUES = new Set(['fit', 'miss', 'heavier']);
// Начало правки черновика: «2:», «2=», «+ …». Короткий текст, который parseEdit не разобрал, — подсказка с /help (без «2.»: так начинаются рассказы-списки).
const EDIT_START = /^(?:\d{1,2}\s*[:=]|\+)/;
// Предел, сколько доставка ролика ждёт проверки сообщений, пришедших во время подготовки (страховка от зависания;
// у самой проверки свой предел и один повтор). По истечении — как «неизвестно» (условие 3).
export const HOLD_WAIT_MS = 120 * 1000;
// Бюджет одной проверки сообщения в окне: вызов модели + пауза + повтор, с запасом (server/draft.js, server/gate.js).
export const CHECK_BUDGET_MS = 2 * SAFETY_TIMEOUT_MS + RETRY_DELAY_MS + 2000;
// Короткие ответы во время подготовки, которые модельную проверку не ждут (условие 2). Сравниваются без знаков.
const TRIVIAL_REPLIES = new Set(['ок', 'окей', 'ok', 'okay', 'ага', 'да', 'угу', 'хорошо', 'ладно', 'жду', 'понял', 'поняла', 'спасибо', 'спс', 'благодарю', 'супер', 'класс', 'круто', 'thanks', 'спасибо большое', 'ок спасибо', 'хорошо спасибо']);
// Предел ожидания одного вызова Telegram API (кроме длинного опроса и загрузки видео).
export const TELEGRAM_CALL_MS = 10 * 1000;

export const TEXT = {
  year: 'Расскажи про свой 2026 год за минуту: что случилось, кто был рядом, что осталось с тобой. Можно голосом.',
  working: 'Монтирую…',
  rendering: 'Собираю ролик. Обычно это меньше минуты.',
  queue: (n) => `Собираю ролик. Перед тобой в очереди: ${n}.`,
  // ИР-04: очередь заполнена, черновик сохранён. Текст редактора повествования (10.11), дословно.
  busy: 'Сейчас очередь заполнена. Черновик остаётся здесь. Нажми «▶ Смотреть титры» ещё раз чуть позже.',
  voiceOff: 'Голосовые пока не подключены. Напиши, пожалуйста, текстом.',
  voiceLong: `Голосовое дольше ${Math.round(MAX_VOICE_SECONDS / 60)} мин. Для одной сцены хватит минуты.`, // «мин.» — без склонения числа
  voiceEmpty: 'Не получилось разобрать голосовое. Можно повторить или написать текстом.',
  tooLong: TOO_LONG_TEXT, // тот же текст, что у draft.js и монтажной
  editExcluded: EDIT_NOT_IN_TITLES_TEXT, // текст — в server/safety.js; окончательный утверждает редактор
  editHelp: [
    'Как поправить:',
    // Примеры без рода: род не угадываем (правило «00 База»).
    '<code>2: вечером прогулка в парке</code> — новая строка 2 из твоих слов',
    '<code>2: Вечером — прогулка в парке</code> — роль и текст',
    '<code>-3</code> — убрать строку 3',
    '<code>+ Ночью — окно и тишина</code> — добавить строку',
    '<code>название: Письмо, которое ушло</code>',
    '<code>жанр: тихая драма</code>',
    '<code>после: Посуда — до завтра.</code> или <code>после: -</code>',
  ].join('\n'),
  noDraft: 'Сначала расскажи о дне: голосом или текстом.',
  fit: 'Хорошо. Ролик можно сохранить или переслать. На сегодня достаточно.',
  miss: 'Понятно. Можно поправить строки, плёнку или музыку и собрать заново. Или просто закончить на сегодня.',
  heavier: 'Спасибо за честный ответ. Можно остановиться прямо сейчас, это нормально.',
  // Исходы /delete — редактор повествования 16:24, решение владельца 17:10 (только вымышленный стенд).
  deleted: 'Сессия и статистика по тебе удалены.',
  // Запись может появиться (идёт черновик или проверка) или стенд не вымышленный: полное удаление не подтверждается.
  deleteKept: 'Полное удаление не подтверждено.',
  // Исход 2 — ТОЛЬКО вымышленный стенд (TITRY_STAND=fictional; редактор 18:25, решение владельца 17:10).
  // Маркер «[срок не утверждён]» не допускается в сборке для реальных данных (tests/release-guard.test.js).
  keptSafety: 'Служебная запись об остановке по безопасности сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]',
  recordUnknown: 'Проверить состояние служебной записи не получилось. Полное удаление не подтверждено.',
  more: 'Расскажи чуть подробнее: что было, что запомнилось.',
  editUnparsed: 'Правку не получилось разобрать. Примеры — /help.', // начатая, но не разобранная правка на черновике
  // Модель не ответила и после повтора, в ролике есть локальный concern (условие 3): текст — в server/safety.js.
  tryLater: () => tryLaterMessage(),
  // Голосовое во время подготовки ролика не распознано (условие 2): ролик не отменяется. Текст — в server/safety.js.
  notHeard: NOT_HEARD_TEXT,
  // ИР-02: проверка недоступна — текст редактора повествования (PM-01, 9.11) дословно. Без срока и без карточки помощи.
  checkUnavailable: 'Ролик задерживается: сервис не завершил проверку. Сейчас отправить его не получится. Ждать в чате и отвечать на это сообщение не нужно.',
  // Черновик текста, на вычитку редактору повествования: честно, без «всё удалено», без обещаний сроков.
  deleteFailed: 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.',
  // Отзыв согласия: удаление статистики не подтверждено. Текст редактора повествования (ПРАВКА-ЗАПРОС 21.11), дословно.
  withdrawForgetFailed: 'Пока не удалось подтвердить удаление твоей статистики. Чтобы повторить запрос, отправь /delete чуть позже.',
  renderFail: 'Не получилось собрать ролик. Попробуй ещё раз чуть позже.',
  draftFail: 'Не получилось собрать черновик. Попробуй ещё раз чуть позже.',
  // Внутренняя причина insufficient_after_exclusion (редактор повествования), дословно: только эта реплика —
  // без черновика, ролика, просьбы дописать и кнопок. Показывается только после stop и технических исходов.
  insufficient: INSUFFICIENT_TEXT, // текст — в server/safety.js
  insufficientInvite: INSUFFICIENT_INVITE_TEXT, // текст — в server/safety.js; утверждает редактор
};

export { TELEGRAM_TEXT_LIMIT };

/**
 * Ответ при нехватке материала: реплика; при concern — одним сообщением «реплика, пустая строка, блок помощи».
 * Контакты — проверенные при старте (prepareHelp в prepareBot), файл во время работы не перечитывается,
 * ветки «реплика без помощи» нет. Защитная ветка: если вместе не помещается в лимит Telegram — СНАЧАЛА блок
 * помощи, ЗАТЕМ реплика, в журнал — код message_too_long (без текста). Сам блок длиннее лимита в рабочем пути
 * не бывает: это ошибка проверки при старте. Параметр help — только для тестов, он эту проверку обходит.
 */
export function insufficientMessages(concern, { help, log = logError } = {}) {
  // Реплика нехватки и сразу приглашение написать строки правкой (решение владельца 12.11 11:05, вариант 1).
  const reply = `${TEXT.insufficient}\n\n${TEXT.insufficientInvite}`;
  if (!concern) return [reply];
  const block = help ? helpMessage('concern', help) : helpMessage('concern');
  const one = `${reply}\n\n${block}`;
  if (one.length <= TELEGRAM_TEXT_LIMIT) return [one];
  log('insufficient', { code: 'message_too_long' });
  return [block, reply];
}

/**
 * Ответ, когда строку из правки не берём в титры. При concern, внесённом правкой, — одним сообщением «реплика, пустая
 * строка, блок помощи concern» (как у нехватки в PR 11); если вместе не помещается — сначала блок помощи.
 */
export function editExcludedMessages(concern, { help, log = logError, path = 'rows.0' } = {}) {
  const text = editNotInTitlesText(path);
  if (!concern) return [text];
  const block = help ? helpMessage('concern', help) : helpMessage('concern');
  const one = `${text}\n\n${block}`;
  if (one.length <= TELEGRAM_TEXT_LIMIT) return [one];
  log('edit', { code: 'message_too_long' });
  return [block, text];
}

/** Длинный экран (6Б) — частями по абзацам в пределах лимита Telegram; кнопки — под последней частью. */
export function splitForTelegram(text, limit = TELEGRAM_TEXT_LIMIT) {
  const parts = [];
  for (const p of String(text).split('\n\n')) {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.length + 2 + p.length <= limit) { parts[parts.length - 1] += `\n\n${p}`; continue; }
    // Заголовок на «:» не отрывается от следующего абзаца: переносится в новую часть вместе с ним.
    const cut = last !== undefined && last.endsWith(':') ? last.lastIndexOf('\n\n') : -1;
    if (cut > 0) { parts[parts.length - 1] = last.slice(0, cut); parts.push(`${last.slice(cut + 2)}\n\n${p}`); } else parts.push(p);
  }
  return parts;
}
const consentKb = (rows) => ({ inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });

// ── Чистые функции: разбор правок ────────────────────────────────────────────

/** Поле эпизода, которое меняет правка (после applyEdit): путь как в ошибках проверки. */
export function editedPath(cmd, ep) {
  switch (cmd.op) {
    case 'add': return `rows.${ep.rows.length - 1}`;
    case 'row': return `rows.${cmd.n - 1}`;
    case 'title': case 'genre': case 'lead': case 'post': return cmd.op;
    default: return null;
  }
}

/** Разобрать команду правки. Возвращает объект команды или null. */
export function parseEdit(text) {
  const t = String(text || '').trim();
  let m;
  if ((m = /^-\s*(\d{1,2})$/.exec(t))) return { op: 'delete', n: Number(m[1]) };
  if ((m = /^\+\s*(.+?)\s+[—–-]\s+(.+)$/.exec(t))) return { op: 'add', role: m[1], value: m[2] };
  if ((m = /^(\d{1,2})\s*[:=.]\s*(.+?)\s+[—–-]\s+(.+)$/.exec(t))) return { op: 'row', n: Number(m[1]), role: m[2], value: m[3] };
  if ((m = /^(\d{1,2})\s*[:=.]\s*(.+)$/.exec(t))) return { op: 'row', n: Number(m[1]), value: m[2] };
  if ((m = /^(название|жанр|после|в главной роли)\s*[:=]\s*(.*)$/i.exec(t))) {
    const key = { 'название': 'title', 'жанр': 'genre', 'после': 'post', 'в главной роли': 'lead' }[m[1].toLowerCase()];
    return { op: key, value: m[2].trim() };
  }
  return null;
}

/** Строка из правки человека: цитата — его роль и текст в том порядке, как editCorpus добавляет их в опору. */
function ownRow(role, value) {
  // Без обрезки: длинную роль или текст покажет проверка черновика понятной ошибкой длины.
  // Правка человека — его собственные слова (решение 3б, 12.11): опора строки — сам текст правки.
  return { role, value, source: `${role} ${value}`, own: true };
}

/** Применить правку к эпизоду. Номера строк — как в сообщении с черновиком (без фиксированных строк). */
export function applyEdit(ep, cmd) {
  const rows = ep.rows;
  const idx = cmd.n - 1;
  switch (cmd.op) {
    case 'delete':
      if (idx < 0 || idx >= rows.length) return `Строки ${cmd.n} нет.`;
      if (rows.length <= LIMITS.rowsMin) return `Должно остаться хотя бы ${LIMITS.rowsMin} строки.`;
      rows.splice(idx, 1); return null;
    case 'add':
      if (rows.length >= LIMITS.rowsMax) return `Больше ${LIMITS.rowsMax} строк не поместится. Сначала убери одну.`;
      // Слова роли и значения — из цитаты этой же строки: цитата — то, что человек написал в правке (роль и текст).
      rows.push(ownRow(cmd.role, cmd.value)); return null;
    case 'row':
      if (idx < 0 || idx >= rows.length) return `Строки ${cmd.n} нет.`;
      if (cmd.role) { rows[idx] = ownRow(cmd.role, cmd.value); return null; }
      // Только новый текст: роль и значение берутся из слов этого же текста (правило 11.11 — без чужих слов).
      // Если пару собрать не из чего, прежняя роль остаётся, проверка черновика покажет ошибку, ролик не соберётся;
      // правку не отклоняем, чтобы её текст прошёл обычную проверку безопасности.
      {
        const pair = pairFromSentence(cmd.value, new Set(), cmd.value);
        if (pair) { rows[idx] = { ...pair.row, own: true }; return null; }
      }
      // пару собрать не из чего (одно слово, сон, «почти»…): роли из этого текста нет — проверка покажет «нет роли»,
      // а не «слово не из рассказа» про прежнюю роль, которой человек не писал
      rows[idx].role = '';
      rows[idx].value = cmd.value;
      rows[idx].source = cmd.value;
      rows[idx].own = true;
      return null;
    case 'title': if (!cmd.value) return 'Название не может быть пустым.'; ep.title = cmd.value.slice(0, LIMITS.title); return null;
    case 'genre': if (!cmd.value) return 'Жанр не может быть пустым.'; ep.genre = cmd.value.slice(0, LIMITS.genre); return null;
    case 'lead': ep.lead = (cmd.value || 'ты').slice(0, 24); return null;
    case 'post':
      ep.post = cmd.value === '-' || !cmd.value ? { text: '', source: '' } : { text: cmd.value, source: cmd.value, own: true };
      // без обрезки, как в ownRow: опора — полный текст правки; длинную сцену покажет понятная ошибка длины
      return null;
    default: return TEXT.editUnparsed;
  }
}

/** Текст правки, который становится частью опоры: человек написал его сам. */
export function editCorpus(cmd) {
  if (cmd.op === 'delete') return '';
  if (cmd.op === 'post' && (cmd.value === '-' || !cmd.value)) return '';
  return [cmd.role, cmd.value].filter(Boolean).join(' ');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ошибка проверки словами для человека: без «цитаты» и служебных терминов. */
export function personMessage(e) {
  if (!e) return '';
  // строка без роли (правка «N: текст», из которого пару не собрать): подсказываем, как написать
  const noRole = /^rows\.(\d+)\.role$/.exec(e.path || '');
  if (noRole && /нет роли/.test(e.msg || '')) return `${e.msg} Напиши её так: «${+noRole[1] + 1}: роль — текст».`;
  if (!String(e.kind || '').startsWith('words:')) return e.msg;
  const n = e.row + 1;
  const redo = `Напиши её заново своими словами: «${n}: роль — текст».`;
  switch (e.kind) {
    case 'words:long': return `Строка ${n}: роль — одно-два слова. ${redo}`;
    case 'words:bound': return `Строка ${n}: в рассказе слово «${e.words[0]}» стоит с другими словами («не», «бы», «если», «сказала»…), а без них смысл другой. ${redo}`;
    case 'words:cut': return `Строка ${n}: в рассказе перед этими словами стоит «не» или похожее слово, без него смысл другой. ${redo}`;
    case 'words:ambiguous': return `Строка ${n}: слово «${e.words[0]}» в рассказе встречается и с «не», и без него. ${redo}`;
    case 'words:empty': return `Строка ${n}: в ней не хватает слов. ${redo}`;
    case 'words:missing': return `Строка ${n}: слово «${e.words[0]}» не из твоего рассказа. ${redo}`;
    default: return `Строка ${n}: эти слова не складываются из твоего рассказа. ${redo}`;
  }
}

/** Черновик в виде сообщения Telegram (HTML). */
export function draftMessage(ep, validation) {
  const lines = [];
  lines.push(`<b>${esc(PERIODS[ep.period]).toUpperCase()} · ${esc(dateLabel(ep.date, ep.period)).toUpperCase()}</b>`);
  lines.push(`«${esc(ep.title)}»`);
  lines.push(`<i>жанр: ${esc(ep.genre)}</i>`, '');
  const rows = creditRows(ep);
  let n = 0;
  for (const r of rows) {
    const num = r.fixed ? '   ' : `${++n}.`;
    lines.push(`${num} ${esc(r.role)} — ${esc(r.value)}`);
  }
  if (ep.post && ep.post.text) lines.push('', `После титров: ${esc(ep.post.text)}`);
  lines.push('', `Плёнка: ${MOODS[ep.mood].film} · музыка: ${TRACKS[ep.music].file ? TRACKS[ep.music].title : 'тишина'}`);
  const problems = validation ? validation.errors : [];
  if (problems.length) lines.push('', ...[...new Set(problems.map(personMessage))].map((m) => `⚠ ${esc(m)}`));
  lines.push('', `Похоже на твой ${ep.period === 'year' ? 'год' : 'день'}? Любую строку можно поправить.`);
  return lines.join('\n');
}

export function draftKeyboard(ep, draftId = 0) {
  const nextMood = MOODS[MOOD_ORDER[(MOOD_ORDER.indexOf(ep.mood) + 1) % MOOD_ORDER.length]];
  const nextMusic = TRACKS[MUSIC_ORDER[(MUSIC_ORDER.indexOf(ep.music) + 1) % MUSIC_ORDER.length]];
  return {
    inline_keyboard: [
      [{ text: '▶ Смотреть титры', callback_data: `play:${draftId}` }],
      // Кнопки меняют на следующую плёнку и музыку; текущие — в сообщении над ними (раньше подпись «Плёнка: X» путала).
      [{ text: `Другая плёнка: ${nextMood.film}`, callback_data: `mood:${draftId}` }],
      [{ text: `Другая музыка: ${nextMusic.file ? nextMusic.title : 'тишина'}`, callback_data: `music:${draftId}` }], // отдельные ряды: название трека не обрезается на телефоне
      [{ text: 'Как поправить строку', callback_data: 'edit' }],
    ],
  };
}

// Значения кнопок — FEEDBACK_VALUES (менять вместе). Метка цикла согласия в кнопках отклика: отклик пишется в метрики, только если ролик отправлен при текущем согласии.
const feedbackKeyboard = (cycle) => ({
  inline_keyboard: [[
    { text: 'Попало', callback_data: `fb:fit:${cycle}` },
    { text: 'Не подходит', callback_data: `fb:miss:${cycle}` },
    { text: 'Стало тяжелее', callback_data: `fb:heavier:${cycle}` },
  ]],
});

// ── Метрики без содержимого рассказов ────────────────────────────────────────

export const MAX_RENDER_WAITING = 3;

// Соль хэшей обязательна (решение Claude 11.11): запасная соль в открытом репозитории позволяет подобрать
// короткие chat id перебором. Без соли — отказ; явный режим разработки (TITRY_DEV_METRICS=1) — случайная соль
// на процесс, не записываемая никуда (удаление после перезапуска в этом режиме строки прежнего процесса не найдёт).
export const METRICS_SALT_MIN = 16;
export function makeMetrics(file = path.join(ROOT, 'data', 'metrics.jsonl'), salt = process.env.METRICS_SALT, { forgetTimeoutMs = 10000 } = {}) {
  if (!salt) {
    if (process.env.TITRY_DEV_METRICS !== '1') throw Object.assign(new Error('METRICS_SALT не задан'), { code: 'metrics_salt' });
    salt = crypto.randomBytes(32).toString('hex');
  }
  const hash = (id) => crypto.createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 16);
  // ИР-06 (критик реализации 9.11): завершённый forget — барьер для уже принятых записей.
  // 1) Чтение-перезапись и дозапись файла идут одной очередью — строка другого человека не теряется.
  // 2) forget сразу поднимает поколение человека; запись, принятая до него, проверяет поколение
  //    уже внутри очереди и не попадает в файл. forget не ждёт зависшую запись.
  let ops = Promise.resolve();
  const serial = (fn) => {
    const run = ops.then(fn);
    ops = run.catch(() => {});
    return run;
  };
  const generation = new Map(); // хэш → номер поколения; текстов здесь нет
  // G0-fixes: запись поколения нужна, только пока есть незавершённые log/forget этого человека.
  // Когда их нет, запись удаляется — карта не растёт с каждым /delete.
  const busy = new Map(); // хэш → число незавершённых операций
  // Временные копии журнала (критик реализации 10.11): если копию не удалось удалить, это не скрывается.
  // Копии запоминаются и удаляются при следующих операциях — ограниченное число попыток. После перезапуска
  // оставшиеся копии этого журнала находятся по имени при первой операции. В журнал ошибок — только код,
  // без пути, хэшей и текстов.
  const TMP_CLEANUP_ATTEMPTS = 3;
  // Только копии этого журнала: «<имя>.tmp-<pid>». Посторонние файлы с похожим именем не трогаем.
  file = path.resolve(file); // один вид пути для копий из папки и для своей копии
  const tmpPattern = new RegExp('^' + path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.tmp-\\d+$');
  const leftovers = new Map(); // имя временной копии → число неудачных попыток удаления
  let scanned = false;
  let scanFailures = 0;
  const cleanupFailed = () => console.error('metrics: временная копия журнала не удалена (metrics_tmp_cleanup_failed)');
  // explicit = вызов из forget: человек сам просит удалить данные, поэтому пробуем и сверх лимита.
  // Лимит действует только на фоновые попытки при записи метрик — без бесконечных повторов в каждом log.
  async function cleanLeftovers(explicit = false) {
    if (!scanned && (explicit || scanFailures < TMP_CLEANUP_ATTEMPTS)) {
      try {
        const entries = await fs.readdir(path.dirname(file), { withFileTypes: true });
        for (const d of entries) if (d.isFile() && tmpPattern.test(d.name)) leftovers.set(path.join(path.dirname(file), d.name), 0);
        scanned = true;
      } catch (e) {
        if (e.code === 'ENOENT') scanned = true; // папки ещё нет — копий тоже
        else {
          scanFailures++;
          console.error(scanFailures < TMP_CLEANUP_ATTEMPTS
            ? 'metrics: не удалось проверить временные копии журнала (metrics_tmp_scan_failed)'
            : 'metrics: проверка временных копий журнала не удалась после повторов (metrics_tmp_scan_exhausted)');
        }
      }
    }
    for (const [tmp, failures] of leftovers) {
      if (failures >= TMP_CLEANUP_ATTEMPTS && !explicit) continue; // фоновые попытки исчерпаны: уже сообщено
      try { await fs.rm(tmp, { force: true }); leftovers.delete(tmp); }
      catch {
        leftovers.set(tmp, failures + 1);
        if (failures + 1 === TMP_CLEANUP_ATTEMPTS) console.error('metrics: временная копия журнала не удалена после повторов (metrics_tmp_cleanup_exhausted)');
      }
    }
  }
  const serialClean = (fn, explicit = false) => serial(async () => { await cleanLeftovers(explicit); return fn(); });
  // Удаление подтверждено, только если копий журнала не осталось и папка проверена:
  // в копии могут лежать строки этого же человека.
  const cleanupPending = () => !scanned || leftovers.size > 0;
  const enter = (h) => busy.set(h, (busy.get(h) || 0) + 1);
  const leave = (h) => {
    const n = (busy.get(h) || 1) - 1;
    if (n > 0) { busy.set(h, n); return; }
    busy.delete(h);
    generation.delete(h);
  };
  return {
    hash,
    /** Только для тестов: сколько людей сейчас держат запись поколения. */
    get trackedUsers() { return generation.size; },
    /** Только для тестов и диагностики: сколько временных копий ждут удаления. */
    get pendingTmpCleanup() { return leftovers.size; },
    // allow — проверка вызывающего прямо перед записью в файл, уже в очереди (например, действует ли ещё согласие).
    async log(chatId, event, extra = {}, { allow } = {}) {
      const h = hash(chatId);
      enter(h);
      try {
        const gen = generation.get(h) || 0;
        const row = JSON.stringify({ at: new Date().toISOString(), user: h, event, ...extra }) + '\n';
        await fs.mkdir(path.dirname(file), { recursive: true });
        return await serialClean(async () => {
          if ((generation.get(h) || 0) !== gen) return; // человек удалил данные, пока запись ждала
          if (allow && !allow()) return; // согласие отозвано, пока запись ждала
          await fs.appendFile(file, row);
        });
      } finally { leave(h); }
    },
    /**
     * Удалить строки человека. Отклоняется, если удаление не подтверждено: сбой чтения (кроме «файла нет»),
     * записи или rename, либо очередь не дошла до удаления за forgetTimeoutMs. Тогда вызывающий
     * не должен говорить «всё удалено». По тайм-ауту удаление остаётся в очереди и выполнится позже.
     */
    forget(chatId) {
      const h = hash(chatId);
      enter(h);
      generation.set(h, (generation.get(h) || 0) + 1);
      const run = serialClean(async () => {
        let text = '';
        const pendingError = () => Object.assign(new Error('Строки удалены из журнала, но временные копии журнала не убраны.'), { code: 'tmp_cleanup_pending', tmpCleanup: 'pending' });
        try { text = await fs.readFile(file, 'utf8'); } catch (e) {
          if (e.code !== 'ENOENT') throw e;
          if (cleanupPending()) throw pendingError(); // журнала нет, но копия может хранить строки человека
          return;
        }
        const kept = text.split('\n').filter((l) => l && !l.includes(`"user":"${h}"`));
        // Атомарно: временный файл и rename — сбой посреди записи не обрезает строки других людей.
        const tmpFile = `${file}.tmp-${process.pid}`;
        try {
          await fs.writeFile(tmpFile, kept.length ? kept.join('\n') + '\n' : '');
          await fs.rename(tmpFile, file);
          leftovers.delete(tmpFile); // копию с этим именем унёс rename
        } catch (e) {
          // Не оставляем копию чужих строк. Если и удалить её не вышло — сообщаем оператору и повторим позже.
          try { await fs.rm(tmpFile, { force: true }); leftovers.delete(tmpFile); }
          catch { if (!leftovers.has(tmpFile)) leftovers.set(tmpFile, 1); cleanupFailed(); e.tmpCleanup = 'failed'; }
          throw e;
        }
        if (cleanupPending()) throw pendingError();
      }, true).finally(() => leave(h));
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Удаление метрик не подтверждено за отведённое время.'), { code: 'timeout' })), forgetTimeoutMs);
      });
      // Если удаление упадёт уже после тайм-аута, оператор должен об этом узнать: только код ошибки, без хэша и текстов.
      let timedOut = false;
      run.catch((e) => { if (timedOut) logError('metrics.forget.after_timeout', e); });
      return Promise.race([run, timeout]).catch((e) => { if (e?.code === 'timeout') timedOut = true; throw e; }).finally(() => clearTimeout(timer));
    },
  };
}

// Подпись — новая строка после расшифровки, с заглавной буквы: перенос — граница предложения (п. 4 КРИТИКИ PR 16).
// Решение 16.11, (б): регистр подписи не меняется — правило строчного продолжения одно для строки, сообщения и правки.
const withCaption = (story, caption) => (caption ? `${story}\n${caption}` : story);
// Новое сообщение, которое начинается с союза продолжения («и», «а потом», «— и …», «🙂 и …», любой регистр), сразу
// после текста, который кончается бытовой формой списка, — продолжение (решение 16.11, (б), уточнение родителя:
// союз, а не регистр). Уровень считается по последней фразе прежнего текста и новому сообщению вместе; продолжение —
// только если этот уровень выше уровня сообщения самого по себе (QA PR 16), иначе 'none'.
const lastPhrase = (t) => String(t || '').trim().split(/(?<=[.!?…])\s+|\n+/).filter(Boolean).at(-1) || '';
export function continuationLevel(prev, next) {
  const body = String(next || '').trim();
  if (!prev || !body) return 'none';
  // Отдельное сообщение — как отдельная строка: решает правило эллиптического продолжения (server/safety.js).
  const tail = lastPhrase(joinEdits(prev));
  // Последняя фраза с собственным уровнем уже обработана при своём сообщении: её уровень не переносим на новое.
  if (assessRisk(tail).level !== 'none') return 'none';
  // Продолжение — только если связь с прежней фразой поднимает уровень (QA PR 16, п. 1): собственный concern или
  // urgent нового сообщения — самостоятельный рассказ, он не наследует прежний.
  const joint = assessRisk(`${tail}\n${body}`).level;
  return LEVEL_RANK[joint] > LEVEL_RANK[assessRisk(body).level] ? joint : 'none';
}
const LEVEL_RANK = { none: 0, concern: 1, urgent: 2 };
// Текст для модельной проверки сообщения: при продолжении — фрагмент и одна предыдущая фраза, не весь рассказ.
const continuationContext = (prev, next) => `${lastPhrase(joinEdits(prev))}\n${String(next || '').trim()}`;

// ── Логика бота (транспорт подменяется в тестах) ─────────────────────────────

export function createBot({
  tg, metrics = makeMetrics(), draft = makeDraft, render = renderEpisode, transcribe = transcribeOgg, now = () => new Date(),
  // Модельная проверка перед рендером (решение владельца кода 13.11 15:00): true — опасно, false — безопасно,
  // исключение — «неизвестно» (один повтор через checkRetryMs). Нет ключа — режим «только локальный фильтр».
  safetyCheck, hasKey = safetyCheck ? () => true : hasClaudeCredentials,
  ledger = null, // хранилище запретов (server/ledger.js); область — участник, производная HMAC на диске
  checkRetryMs = RETRY_DELAY_MS,
  gate = makeGate({ check: safetyCheck || ((text) => modelSafetyCheck(text)), hasKey, ledger, retryDelayMs: checkRetryMs }),
  checkBudgetMs = CHECK_BUDGET_MS, // бюджет ожидания одной проверки сообщения в окне (вызов + повтор)
  holdWaitMs = HOLD_WAIT_MS, // жёсткий общий предел ожидания проверок сообщений, пришедших во время подготовки ролика
  renderTimeoutMs = RENDER_TIMEOUT_MS, // предел активного рендера от старта задачи в слоте (server/render.js)
  renderGraceMs = KILL_GRACE_MS, // запасной предел: renderTimeoutMs + 2×renderGraceMs — слот освобождается принудительно
  botName = null, // имя бота (getMe): «/команда@другой_бот» — не наша команда; без имени «@…» отрезается у любой
  consentOrder = consentSteps(), // порядок 6Б/6Г после 6А (TITRY_CONSENT_ORDER), не утверждён до правовой проверки
} = {}) {
  const sessions = new Map();
  // Команда: «/имя», без учёта регистра; «@имя_бота» отрезается только для своего бота. Иначе — не команда (null).
  const parseCommand = (text) => {
    const m = /^\/([A-Za-z]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text);
    if (!m || (m[2] && botName && m[2].toLowerCase() !== String(botName).toLowerCase())) return null;
    return { name: m[1].toLowerCase(), tail: (m[3] || '').trim() };
  };
  // Рассказ для проверок безопасности: вместе с правками, отклонёнными по длине (s.overflow, только в памяти).
  // Иначе угрозу можно разбить на две правки у предела: первая отклонена и выпала бы из контекста фильтра.
  const seenStory = (s) => (s.overflow?.length ? `${s.story}${EDIT_SEP}${s.overflow.join(EDIT_SEP)}` : s.story);
  // Метрики — только при действующем согласии (проверка перед запуском, п. 3): до 6Ж, после отказа, /start, /delete
  // (сессии нет) и для поздних кнопок старых сообщений запись не делается. Запись привязана к циклу согласия, в котором
  // началось событие (рассказ, доставка, сообщение во время доставки; новый цикл — только через /start), и проверяется
  // дважды: при вызове и в очереди прямо перед записью
  // в файл (QA PR 31, п. 1): /start или «Нет», пришедшие, пока запись ждала, её отменяют.
  // Отложенный сброс относится к своей доставке (forgetGen): после нового согласия и нового рассказа он метрики не держит.
  const cycleOf = (chatId) => sessions.get(chatId)?.consent?.cycle;
  // Та же сессия и то же действующее согласие, что при приходе сообщения (без учёта отложенного сброса доставки:
  // новое согласие во время старой доставки принимает новые рассказы).
  const sameConsent = (chatId, s, cycle) => sessions.get(chatId) === s && consentDone(s) && s.consent.cycle === cycle;
  const consented = (chatId, cycle) => {
    const s = sessions.get(chatId);
    return !!s && consentDone(s) && s.consent.cycle === cycle && !(s.forgetAfter && s.forgetGen === s.draftId);
  };
  const writeMetric = async (chatId, event, data, cycle = cycleOf(chatId)) => {
    if (consented(chatId, cycle)) await metrics.log(chatId, event, data, { allow: () => consented(chatId, cycle) });
  };
  // Метрики «как получится»: сбой записи (например, ENOSPC) не должен ломать ответ человеку. В журнал — только код.
  // Цикл берётся при вызове: событие относится к согласию, действовавшему в этот момент.
  const logMetric = (chatId, event, data, cycle = cycleOf(chatId)) => Promise.resolve().then(() => writeMetric(chatId, event, data, cycle)).catch((e) => logError('metrics', e));
  // Незавершённые черновики и отдельные проверки участника: их результат может создать запрет уже после /delete.
  const inFlight = new Map();
  const track = async (chatId, p) => {
    inFlight.set(chatId, (inFlight.get(chatId) || 0) + 1);
    try { return await p; } finally {
      const n = inFlight.get(chatId) - 1;
      if (n > 0) inFlight.set(chatId, n); else inFlight.delete(chatId);
    }
  };
  // Ключ рассказа: запрет по безопасности привязан к самому рассказу, а не к интерфейсу.
  const storyKey = (story) => crypto.createHash('sha256').update(String(story).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()).digest('hex');
  let queue = Promise.resolve();
  let waiting = 0; // рендеры в работе и в ожидании

  const session = (chatId) => {
    let s = sessions.get(chatId);
    // scope — область запретов шлюза: участник (чат), а не сессия. /delete удаляет сессию и статистику,
    // но не снимает запрет safety (решение владельца 15:08 / 16:00). На диск — только HMAC области.
    if (!s) { s = { stage: 'idle', period: 'day', scope: `chat:${chatId}` }; sessions.set(chatId, s); }
    s.touched = Date.now();
    return s;
  };

  function sweep() {
    const limit = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) if (s.touched < limit) sessions.delete(id);
  }

  async function showDraft(chatId, s) {
    s.validation = validateSafeEpisode(s.episode, s.story);
    await tg.send(chatId, draftMessage(s.episode, s.validation), { parse_mode: 'HTML', reply_markup: draftKeyboard(s.episode, s.draftId) });
  }

  // Остановка по безопасности: прежний черновик уничтожается, рассказ запоминается как запрещённый.
  // Состояние остановки применяется синхронно, до любых отправок: сбой отправки не отменяет остановку.
  function applyStop(s) {
    s.episode = null;
    s.skeleton = null;
    s.verdict = 'blocked';
    s.draftId = (s.draftId || 0) + 1; // кнопки всех прежних черновиков перестают работать; ролик не уходит
    s.stage = 'help';
    if (s.story) {
      s.blocked = s.blocked || new Set();
      s.blocked.add(storyKey(s.originalStory || s.story));
      gate.markSafety(s.scope, s.originalStory || s.story);
    }
  }
  // cycle — цикл согласия, в котором началось событие (по умолчанию — текущий при вызове, до первого await).
  async function stopForSafety(chatId, s, level, extra = {}, cycle = cycleOf(chatId)) {
    applyStop(s);
    // Экран остановки — до записи в журнал: сбой или зависание журнала не задерживает помощь.
    try { await tg.send(chatId, helpMessage('urgent')); }
    finally { try { await writeMetric(chatId, 'safety', { level, ...extra }, cycle); } catch (e) { logError('metrics', e); } }
  }

  // Сессия ещё та же: не удалена через /delete и не заменена новой после истечения срока.
  const alive = (chatId, s) => sessions.get(chatId) === s;

  // ── Подтверждения до приёма рассказа (комплект для юриста v2, пакет согласия v8, 2.1) ──
  // Отметка о согласии — только в памяти сессии (s.consent): регистрация согласия в карте v4 запланирована, хранилище не
  // выбрано. Сессия стирается по /delete, через три часа без сообщений и при перезапуске — тогда подтверждения заново.
  // До 6Ж и после отказа рассказ не принимается: голос не скачивается, SpeechKit, модель, метрика story и рендер не
  // вызываются, содержание в сессию не пишется (QA «Приём рассказа до подтверждений», критерии 1–3).
  const consentDone = (s) => s.consent?.step === 'done';
  async function consentScreen(chatId, s, step) {
    s.consent.step = step;
    const { cycle } = s.consent; // до первой отправки: /start во время отправки частей 6Б не перепишет метку старого экрана
    if (step === 'pd') {
      const parts = splitForTelegram(CONSENT_TEXT.pd);
      for (const p of parts.slice(0, -1)) await tg.send(chatId, p);
      return tg.send(chatId, parts.at(-1), { reply_markup: consentKb([[[CONSENT_TEXT.pdYes, `cs:pd:yes:${cycle}`], [CONSENT_TEXT.pdNo, `cs:pd:no:${cycle}`]]]) });
    }
    if (step === 'age') return tg.send(chatId, CONSENT_TEXT.age, { reply_markup: consentKb([[[CONSENT_TEXT.ageYes, `cs:age:yes:${cycle}`], [CONSENT_TEXT.ageNo, `cs:age:no:${cycle}`]]]) });
    // 6Ж — единственное приглашение, и после /year (решение Claude 18.11, п. 5); период года сохраняется в s.period.
    return tg.send(chatId, CONSENT_TEXT.ready);
  }
  // Рассказ и черновик из памяти сессии: при повторных подтверждениях и при отказе (решение Claude 18.11, пп. 7, 8).
  // Новое поколение draftId: начатый черновик больше не покажется. Запреты safety (s.blocked) не трогаем.
  // forgotGen — поколение сброшенного черновика: его опасный ответ модели всё равно показывает экран остановки.
  // Во время доставки ролика сброс откладывается до её конца (forgetAfter, см. doRender).
  const forgetStory = (s) => {
    if (s.delivering) { s.forgetAfter = true; s.forgetGen = s.draftId; return; }
    s.forgetAfter = false;
    // Поколение меняется, только если есть что забыть: повторный сброс (/start, затем «Нет») не затирает forgotGen.
    if (s.story) { s.forgotGen = s.draftId; s.draftId += 1; }
    s.story = s.originalStory = s.overflow = s.episode = s.skeleton = s.verdict = null;
    s.stage = 'idle';
  };
  // 6А с начала; прежние нажатия не засчитываются (2.1: «Повторный /start начинает с 6А»).
  function startConsent(chatId, s) {
    forgetStory(s); // идущая доставка — по прежним правилам, сброс после неё
    // cycle — метка этого прохождения в кнопках: кнопка со старого экрана (до /start, /delete, перезапуска) не засчитывается.
    s.consent = { step: 'intro', given: {}, notified: null, cycle: crypto.randomBytes(4).toString('hex') };
    return tg.send(chatId, CONSENT_TEXT.intro, { reply_markup: consentKb([[[CONSENT_TEXT.introNext, `cs:intro:next:${s.consent.cycle}`]]]) });
  }
  async function onConsent(chatId, s, data) {
    const c = s.consent;
    const [, step, answer, cycle] = data.split(':');
    // Кнопка не текущего шага или прежнего прохождения (Критик реализации 18.11 21:40) — ничего не засчитываем.
    if (!c || c.step !== step || cycle !== c.cycle) return;
    // Только кнопки, которые показаны на этом экране (QA PR 32 03b4b93): 6А — «Далее»; 6Б, 6Г — «Да» и «Нет»
    // (клавиатуры — в startConsent и consentScreen; менять вместе). На шагах done и declined кнопок нет.
    // Любое другое значение ничего не меняет: шаг, отметки и метрики остаются, следующий экран не отправляется.
    if (!(step === 'intro' ? answer === 'next' : consentOrder.includes(step) && (answer === 'yes' || answer === 'no'))) return;
    const next = step === 'intro' ? consentOrder[0] : consentOrder[consentOrder.indexOf(step) + 1] || 'done';
    if (answer === 'next' || answer === 'yes') {
      if (step === 'pd') c.given.pd = { at: now().toISOString(), version: CONSENT_VERSION };
      return consentScreen(chatId, s, next);
    }
    c.step = 'declined'; // отказ как событие не храним; дальше бот ничего не спрашивает и не напоминает
    forgetStory(s);
    // Отзыв согласия = удаление метрик, как /delete (решение Claude 20.11). Запуск — синхронно, до ответов: запись,
    // уже стоящая в очереди, отбрасывается барьером поколения. Сбой — код в журнал и честное сообщение после ответов.
    const forgot = (async () => metrics.forget(chatId))().then(() => true, (e) => { logError('metrics.forget.withdraw', e); return false; }); // тело — синхронно
    if (step === 'pd') await tg.send(chatId, CONSENT_TEXT.pdDeclined);
    else {
      // 6Г «Нет»: отметки о согласии удаляются (в памяти — всегда успешно); отметку «младше 18» не храним.
      const had = Object.keys(c.given).length > 0;
      c.given = {};
      await tg.send(chatId, CONSENT_TEXT.ageDeclined);
      if (had) await tg.send(chatId, CONSENT_TEXT.ageDeleted);
    }
    if (!(await forgot)) return tg.send(chatId, TEXT.withdrawForgetFailed);
  }
  // Сообщение до конца подтверждений: 6З не чаще раза на шаг; без начатого диалога — 6З и 6А; после отказа — тишина.
  async function preConsent(chatId, s) {
    const c = s.consent;
    if (!c) { await tg.send(chatId, CONSENT_TEXT.notYet); await startConsent(chatId, s); s.consent.notified = 'intro'; return; }
    if (c.step === 'declined' || c.notified === c.step) return;
    c.notified = c.step;
    return tg.send(chatId, CONSENT_TEXT.notYet);
  }
  const isBlocked = (s, story) => !!(s.blocked && s.blocked.has(storyKey(story)));

  // Сообщение пришло при другом согласии (отзыв или новый цикл, пока шли распознавание и ответы): по правилам до 6Ж.
  // Сессии нет (/delete) — ничего не отвечаем. Явная опасность, в том числе продолжение прежнего рассказа, — экран
  // остановки; иначе модель не вызывается, в сессию и метрики ничего не пишется; до нового согласия — 6З.
  // После нового согласия старое сообщение не используется (человек отправит рассказ заново).
  function outsideConsent(chatId, s, text) {
    if (!alive(chatId, s)) return undefined;
    if (assessRisk(text).level === 'urgent' || continuationLevel(seenStory(s), text) === 'urgent') return tg.send(chatId, helpMessage('urgent'));
    return consentDone(s) ? undefined : preConsent(chatId, s);
  }
  // cycle — цикл согласия, в котором пришло сообщение (голосовое — до распознавания, QA PR 31 5d24307).
  async function handleStory(chatId, s, story, source, cycle = cycleOf(chatId)) {
    // Граница рассказа (QA PR 31 ef95836): сообщение пришло при другом согласии (отзыв или новый цикл, пока шли
    // распознавание и ответы) — в сессию и в модель не идёт; явная опасность — экран остановки.
    if (!sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, story);
    const prevStory = seenStory(s); // с правками, отклонёнными по длине: продолжение видит и их
    // Решение 16.11 (б): тревожный обрывок после бытовой формы прежнего текста — продолжение рассказа уровня concern:
    // черновик строится по обоим сообщениям вместе, дальше решает модельная проверка перед рендером.
    const cont = continuationLevel(prevStory, story);
    // У предела длины склейка целиком не поместится в черновик: тогда — последняя фраза и обрывок (как в проверке).
    if (cont === 'concern') story = prevStory.length + story.length < STORY_MAX ? `${prevStory}\n${story}` : continuationContext(prevStory, story);
    // Новый рассказ сразу отменяет прежний черновик: его кнопки больше ничего не запускают.
    s.episode = null;
    s.skeleton = null;
    s.verdict = null;
    s.draftId = (s.draftId || 0) + 1;
    const gen = s.draftId; // поколение: результат ожидания применяется, только если оно всё ещё текущее
    s.story = story;
    s.originalStory = story;
    s.overflow = null;
    s.stage = 'drafting';
    // Решение 16.11 (б): однозначное продолжение бытовой формы прежнего текста — остановка. Собственный urgent нового
    // сообщения после рассказа — тоже сразу, до любых отправок (как до разбора QA PR 16).
    if (cont === 'urgent' || (prevStory && assessRisk(story).level === 'urgent')) return stopForSafety(chatId, s, 'urgent', { at: 'continuation' }, cycle);
    const prior = gate.status(s.scope, story);
    if (isBlocked(s, story) || prior.kind === 'safety') {
      return stopForSafety(chatId, s, 'urgent', { at: 'repeat' }, cycle);
    }
    if (prior.kind) {
      // Хранилище запретов недоступно: черновик не делается, без карточки помощи.
      logError('check', { code: prior.code });
      s.stage = 'idle';
      return tg.send(chatId, TEXT.checkUnavailable);
    }
    const current = () => sameConsent(chatId, s, cycle) && s.draftId === gen && !isBlocked(s, story) && gate.status(s.scope, story).kind !== 'safety';
    await tg.action(chatId, 'typing');
    await tg.send(chatId, TEXT.working);
    // Согласие сменилось, пока шли ответы: модель не вызывается. Запрет, поставленный за это время, — ниже, после
    // черновика (поздняя остановка), как раньше.
    if (!sameConsent(chatId, s, cycle) || s.draftId !== gen) return;
    let r;
    try {
      r = await track(chatId, draft(story, { date: todayIso(now()), period: s.period, tone: 'quiet' }));
    } catch (e) {
      logError('draft', e);
      if (!current()) return;
      s.stage = 'idle';
      await tg.send(chatId, TEXT.draftFail);
      return;
    }
    // Опасный черновик, пришедший после /delete или смены сессии: запрет участника записывается всё равно
    // (область — чат, а не сессия), но в чат ничего не отправляется.
    if (r && !r.unavailable && !r.draftFailed && !r.insufficient && !r.episode) gate.markSafety(`chat:${chatId}`, story);
    if (r && r.modelConcern) gate.markConcern(s.scope, story);
    if (!alive(chatId, s)) return; // удалённая сессия не оживает из отложенного ответа
    if (r.unavailable) {
      // ИР-02: проверка не завершена — техническое состояние, не остановка: рассказ не запоминается
      // как запрещённый, карточка помощи не показывается, черновика и ролика нет.
      logError('draft', { code: r.code });
      if (!current()) return;
      s.stage = 'idle';
      return tg.send(chatId, TEXT.checkUnavailable);
    }
    if (r.draftFailed) {
      // Решение 16.11, п. 1.1: черновика нет и заготовка не собирается — техническая реплика, без контактов.
      logError('draft', { code: r.code });
      if (!current()) return;
      s.stage = 'idle';
      return tg.send(chatId, TEXT.renderFail);
    }
    if (r.insufficient) return replyInsufficient(chatId, s, story, gen, current, r.risk && r.risk.level === 'concern', r.code, cycle);
    if (!r.episode) {
      // Остановка важнее всего, даже если ответ устарел: рассказ запоминается как запрещённый.
      if (s.draftId === gen) return stopForSafety(chatId, s, r.risk.level, { byModel: r.risk.byModel }, cycle);
      s.blocked = s.blocked || new Set();
      s.blocked.add(storyKey(story));
      gate.markSafety(s.scope, story);
      // Если сейчас в работе тот же рассказ или его сбросил повторный /start / отказ, — экран остановки.
      if (s.forgotGen === gen || (s.verdict !== 'blocked' && s.originalStory && storyKey(s.originalStory) === storyKey(story))) {
        return stopForSafety(chatId, s, r.risk.level, { byModel: r.risk.byModel, at: 'late' }, cycle);
      }
      return;
    }
    if (!current()) {
      // Устаревший «можно» молча отбрасывается. Но если тот же рассказ этой сессии тем временем остановлен
      // (например, проверкой прежней сессии до /delete), человек получает карточку помощи, а не тишину.
      if (alive(chatId, s) && (s.forgotGen === gen || (s.verdict !== 'blocked' && s.originalStory && storyKey(s.originalStory) === storyKey(story)))
        && (isBlocked(s, story) || gate.status(s.scope, story).kind === 'safety')) return stopForSafety(chatId, s, 'urgent', { at: 'late' }, cycle);
      return;
    }
    await logMetric(chatId, 'story', { source, period: s.period, chars: Math.round(story.length / 50) * 50 }, cycle);
    if (!current()) return;
    if (r.risk.level === 'concern') await tg.send(chatId, helpMessage('concern'));
    // Решение 16.11 (в): флаг модели — мягкий блок с контактами рядом с черновиком, без остановки ролика.
    else if (r.modelConcern) await tg.send(chatId, modelConcernMessage());
    if (!current()) return;
    s.episode = r.episode;
    s.verdict = 'ok';
    s.edits = 0;
    s.stage = 'draft';
    await logMetric(chatId, 'draft', { provider: r.provider, rows: r.episode.rows.length, dropped: (r.dropped || []).length }, cycle);
    if (!current()) return;
    await showDraft(chatId, s);
  }

  // Нехватка материала после исключения опасных частей (insufficient_after_exclusion). Порядок исходов:
  // stop (safety) → хранилище недоступно → нехватка.
  // В метрики — только код события, без текста рассказа и номеров предложений.
  // Решение владельца 1 (PR 11): если исключался фрагмент уровня concern, сразу за репликой — тот же блок помощи,
  // что у прежней карточки concern (helpMessage('concern')), без переходной фразы, черновика и кнопок.
  // Признак concern — уровень всего рассказа, как у прежней карточки. Решение владельца 11.11 09:05: ОДНО сообщение
  // «реплика, пустая строка, блок помощи» — между двумя сообщениями блок помощи мог бы потеряться. Длина
  // (реплика + helpMessage('concern')) ограничена тестом (≤ 3500) и проверяется при отправке (insufficientMessages):
  // сверх 4096 — сначала блок помощи, затем реплика, код message_too_long в журнале; сейчас 256 знаков.
  // Решение владельца 11.11 12:05, п. 4: обычная нехватка у заготовки (insufficient_material) идёт тем же путём
  // и с той же репликой; в метрику — только код причины из закрытого списка.
  // cycle — цикл согласия, в котором пришёл рассказ (из handleStory).
  async function replyInsufficient(chatId, s, story, gen, current, concern, code = INSUFFICIENT_AFTER_EXCLUSION, cycle = cycleOf(chatId)) {
    // Тот же рассказ сейчас в работе и ещё не остановлен: поздняя остановка (как в ветке !r.episode, at: 'late').
    // Без этого два подряд одинаковых рассказа, у первого из которых проверка вернула true, оставляли человека
    // без карточки помощи: первый ответ устарел, у второго current() уже false из-за safety — оба молча выходили.
    const sameStoryInWork = () => alive(chatId, s) && (s.forgotGen === gen || (s.verdict !== 'blocked' && !!s.originalStory && storyKey(s.originalStory) === storyKey(story)));
    const stoppedNow = () => isBlocked(s, story) || gate.status(s.scope, story).kind === 'safety';
    if (!current()) {
      if (stoppedNow() && sameStoryInWork()) return stopForSafety(chatId, s, 'urgent', { at: 'late' }, cycle);
      return;
    }
    // Модельной проверки здесь нет (решение владельца кода 13.11 15:00): модельная проверка одна — перед рендером, на
    // всём, что попадёт в ролик. Рассказ уже прошёл локальный фильтр в черновике; запрет и хранилище — по состоянию.
    const st = gate.status(s.scope, story);
    if (st.kind) { logError('check', { code: st.code }); s.stage = 'idle'; return tg.send(chatId, TEXT.checkUnavailable); }
    s.stage = 'idle'; // заготовка появится только перед самой отправкой реплики (восьмой разбор)
    await logMetric(chatId, code === INSUFFICIENT_MATERIAL ? INSUFFICIENT_MATERIAL : INSUFFICIENT_AFTER_EXCLUSION, undefined, cycle);
    if (!current()) {
      // Пока писалась метрика, тот же рассказ остановлен (например, проверкой прежней сессии): карточка помощи, не тишина.
      if (stoppedNow() && sameStoryInWork()) return stopForSafety(chatId, s, 'urgent', { at: 'late' }, cycle);
      return;
    }
    // Черновика нет, но человек может написать строки сам (вариант 1): правки ложатся на пустую заготовку эпизода
    // (название, жанр, плёнка — из draftRuleBased, строк нет). Кнопок нет, пока нет черновика.
    s.stage = 'compose';
    s.skeleton = draftRuleBased(story, { date: todayIso(now()), period: s.period }).episode;
    for (const text of insufficientMessages(concern)) await tg.send(chatId, text);
  }

  async function doRender(chatId, s) {
    // Правки после черновика тоже проверяются: опасная строка не попадёт в ролик.
    if (s.verdict !== 'ok' || !s.episode) return tg.send(chatId, TEXT.noDraft);
    // Черновик, сброшенный отзывом согласия во время доставки: ▶ не запускает ни проверку, ни рендер.
    if (!consentDone(s) || (s.forgetAfter && s.forgetGen === s.draftId)) return tg.send(chatId, TEXT.noDraft);
    const cycle = s.consent.cycle; // метрики этой доставки — только в её цикле согласия (QA PR 31, п. 2)
    const risk = assessEpisodeRisk(joinEdits(seenStory(s)), s.episode); // правки — продолжение рассказа для проверки безопасности
    if (risk.level === 'urgent') return stopForSafety(chatId, s, 'urgent', { at: 'render' });
    const v = validateSafeEpisode(s.episode, s.story);
    if (!v.ok) { await showDraft(chatId, s); return; }
    const gen = s.draftId;
    const original = s.originalStory || s.story;
    // Согласие отозвано или подтверждения начаты заново (/start, «Нет» на 6Б/6Г; forgetAfter) — ролик не уходит,
    // черновик стирается после доставки по правилу отказа (решение Claude 19.11 по справке к комплекту v2.2).
    const current = () => alive(chatId, s) && s.draftId === gen && s.verdict === 'ok' && consentDone(s) && !(s.forgetAfter && s.forgetGen === gen) && !isBlocked(s, original) && gate.status(s.scope, original).kind === null;
    // ИР-04 (критик реализации): один рендер идёт, до трёх ждут. Дальше — явный ответ «занято», без долговечной очереди.
    if (waiting >= 1 + MAX_RENDER_WAITING) return tg.send(chatId, TEXT.busy); // состояние сессии не меняется
    const ep = structuredClone(s.episode);
    const story = seenStory(s);
    // Модельная проверка перед рендером — одна, на всём, что попадёт в ролик (условие 1): рассказ со всеми правками
    // (расшифровки, подписи, «/текст» уже в нём) и итоговые строки титров. Рендер стартует только после её результата.
    s.stage = 'rendering';
    // Доставка идёт: сообщения до её конца проверяются первыми (duringRender), даже если /start сменил стадию.
    // Номер доставки: отмена (s.veto) действует на все доставки с номером не больше своего, начатые до неё;
    // новое «Смотреть титры» после отмены — новая доставка, отмена на неё не переносится.
    const myDelivery = s.deliveries = (s.deliveries || 0) + 1;
    const cancelled = () => (s.veto || 0) >= myDelivery;
    s.delivering = (s.delivering || 0) + 1;
    try {
    const text = `${joinEdits(story)}\n${episodeToText(ep)}`;
    const g = await track(chatId, gate.verify(s.scope, original, ep, text));
    if (!alive(chatId, s) || s.draftId !== gen) return; // удалённая или заменённая сессия не оживает
    if (g.kind === 'safety') return stopForSafety(chatId, s, 'urgent', { at: 'check', byModel: !!g.byModel }, cycle);
    if (g.unknown) {
      // «Неизвестно» и после повтора (условие 3): локально чисто — ролик делается; есть concern — ролика нет.
      logError('check', { code: g.code });
      // Отказ проверяющей модели (refusal) — как локальный concern.
      if (g.refusal || gate.hasConcern(s.scope, original) || assessEpisodeRisk(joinEdits(story), ep).level !== 'none') {
        s.stage = 'draft';
        return tg.send(chatId, TEXT.tryLater());
      }
    } else if (!g.ok) {
      // Хранилище запретов недоступно: выдачи нет.
      logError('check', { code: g.code });
      s.stage = 'draft';
      return tg.send(chatId, TEXT.checkUnavailable);
    }
    if (!current()) { if (alive(chatId, s) && s.stage === 'rendering') s.stage = s.verdict === 'blocked' ? 'help' : 'draft'; return; }
    // Сообщение во время проверки уже отменило эту доставку (ответ отправлен) — рендер не запускается.
    // Начало окна «после проверки — до отправки»: от него считается жёсткий общий предел ожидания доставки.
    // Время в очереди и рендера в предел не входит (окно ждёт не дольше holdWaitMs сверх подготовки ролика).
    const windowStart = Date.now();
    let renderMs = 0;
    let slotStart = 0; // старт задачи в слоте рендера
    if (cancelled()) { s.stage = 'draft'; return; }
    if (waiting >= 1 + MAX_RENDER_WAITING) { s.stage = 'draft'; return tg.send(chatId, TEXT.busy); }
    const ahead = waiting;
    waiting++;
    let released = false;
    const release = () => { if (!released) { released = true; waiting--; } }; // место в очереди — до ожидания проверок
    const out = path.join(botTmpDir(), `${metrics.hash(chatId)}-${Date.now()}.mp4`);
    const STALE = Symbol('stale');
    let job;
    try {
      await tg.send(chatId, ahead ? TEXT.queue(ahead) : TEXT.rendering);
      job = queue.then(async () => {
        // Перед стартом из очереди: черновик мог быть остановлен или удалён, пока задача ждала.
        if (!current()) return STALE;
        await tg.action(chatId, 'upload_video');
        // R3 (ревью QA 9.11): пока ждали tg.action, могла прийти остановка или /delete — рендер не начинается.
        if (!current()) return STALE;
        // Предел активного рендера: отсчёт от старта в слоте; слот свободен только после выхода процесса или SIGKILL.
        slotStart = Date.now();
        return withRenderTimeout((signal) => render(ep, { story, outPath: out, preset: process.env.BOT_PRESET || 'standard', watermark: WATERMARK || false, signal }), renderTimeoutMs, { files: [out], graceMs: renderGraceMs });
      });
      queue = job.catch(() => {});
      const renderFrom = Date.now();
      const r = await job;
      // Время в очереди + чистый рендер, ограниченный пределом активного рендера (п. 8 коммита 4): окно проверки сообщений
      // не сокращается для задачи, долго ждавшей в очереди, и не растёт сверх предела рендера.
      const done = Date.now();
      renderMs = slotStart ? (slotStart - renderFrom) + Math.min(done - slotStart, renderTimeoutMs) : Math.min(done - renderFrom, renderTimeoutMs);
      // После рендера: если черновик остановлен или сессия удалена, видео не отправляется (файл удалится ниже).
      if (r === STALE || !current()) return;
      // Доставка ждёт модельной проверки сообщений, пришедших в окно «после проверки — до отправки» (условие 2).
      release();
      const holdDeadline = windowStart + renderMs + holdWaitMs;
      // Можно ли отправлять: дождаться проверок сообщений окна (в пределах того же бюджета) и применить их итог.
      // Вызывается до чтения файла и ещё раз после него, прямо перед запросом (QA PR 27): проверки, пришедшие,
      // пока читался файл, тоже учитываются.
      let timeoutLogged = false; // таймаут проверки — одна запись в журнал на доставку, хоть вызовов два
      const clearToSend = async () => {
        const pending = await waitHolds(s, holdDeadline);
        if (pending.length) {
          // Предел ожидания истёк — как «неизвестно» (условие 3): у ждущих сообщений есть concern — ролика нет.
          if (!timeoutLogged) { timeoutLogged = true; logError('check', { code: 'timeout' }); }
          if (pending.includes('concern')) {
            s.deliveryEpoch = (s.deliveryEpoch || 0) + 1;
            s.veto = s.deliveries;
            if (current()) { s.stage = 'draft'; await sendSafe(chatId, TEXT.tryLater()); }
            return false;
          }
        }
        // Сообщение окна с concern, по которому модель не ответила, отменило ролик (условие 3): ответ уже отправлен.
        if (cancelled()) { if (current()) s.stage = 'draft'; return false; }
        return current();
      };
      if (!(await clearToSend())) return;
      // ready — та же проверка после чтения файла, прямо перед запросом (QA PR 27, п. 2). Загрузка, уже начатая,
      // не отзывается: Telegram не умеет отменить отправку; окно — время одного HTTP-запроса.
      const sent = await tg.sendVideo(chatId, r.outPath, { caption: 'Конец сцены.', width: 720, height: 1280, duration: Math.round(r.duration), reply_markup: feedbackKeyboard(cycle) }, { ready: clearToSend });
      if (sent === null) return; // отзыв или отмена во время чтения файла: ролика нет — и метрики render нет
      // /delete во время отправки: после metrics.forget новая запись о человеке не появляется.
      if (!alive(chatId, s)) return;
      await logMetric(chatId, 'render', { seconds: Math.round(r.seconds), mood: ep.mood, music: ep.music, edits: s.edits || 0 }, cycle);
      if (current()) s.stage = 'watched';
    } catch (e) {
      release(); // следующая задача и новые запросы — сразу
      const timedOut = e?.code === 'render_timeout';
      // Предел рендера: в журнал и метрики — только код и длительность; новая запись о человеке — только у живой сессии.
      if (timedOut) { logRenderTimeout('render', e.ms); if (alive(chatId, s)) try { await writeMetric(chatId, 'render_timeout', { ms: Math.round(e.ms) }, cycle); } catch (m) { logError('metrics', m); } }
      else logError('render', e);
      // Сессия неактуальна (/delete, новый рассказ, отмена доставки) — по отменённой задаче ни одного сообщения.
      if (current() && !(timedOut && cancelled())) {
        s.stage = 'draft';
        await tg.send(chatId, TEXT.renderFail);
      }
    } finally {
      release();
      await removeQuiet([out]); // ошибка удаления — в журнал только код
    }
    } finally {
      s.delivering--;
      // Отложенный сброс — только если за это время не начат новый рассказ (новые подтверждения → новый черновик).
      if (!s.delivering && s.forgetAfter) { if (s.draftId === s.forgetGen) forgetStory(s); else s.forgetAfter = false; }
    }
  }

  // Сообщение, пришедшее во время подготовки ролика: окно «после проверки — до отправки» (решение владельца кода
  // 13.11 15:00, условие 2). Текст сообщения не пишется в журнал и метрики.
  //  - локальный фильтр всегда: urgent → ролик отменяется, экран остановки;
  //  - текст (не эмодзи, не команда, не короткое «ок/спасибо») → отправка ролика ждёт одной модельной проверки
  //    этого сообщения до применения её результата: опасно → отмена и экран остановки; «неизвестно» и после повтора →
  //    при локальном concern ролика нет («не получилось» и контакты), при локально чистом — ролик уходит;
  //  - concern без опасности по модели → блок помощи, ролик уходит (он сделан из проверенного рассказа).
  // Удержание: Map промис → локальный уровень сообщения (по нему решается истечение предела ожидания).
  // Бюджет ожидания привязан к зарегистрированной проверке (КРИТИКА PR 16, п. 3): один вызов + один повтор
  // (checkBudgetMs от регистрации). Жёсткий общий предел — holdWaitMs от начала окна, время очереди и рендера не считается
  // (windowStart + renderMs + holdWaitMs; отступление от буквы решения — в docs/DECISIONS.md): позднее сообщение продлевает
  // ожидание в пределах своего бюджета, но не дальше этого предела.
  // budget: Infinity — удержание на время распознавания голоса: его ограничивает только жёсткий предел, бюджет проверки
  // начинается с регистрации самой проверки (duringRender).
  const holdDelivery = (s, p, level = 'none', budget = checkBudgetMs) => {
    s.holds = s.holds || new Map();
    s.holds.set(p, { level, deadline: Date.now() + budget });
    p.finally(() => s.holds.delete(p)).catch(() => {});
  };
  // [] — все проверки применены; иначе бюджеты или жёсткий предел исчерпаны — уровни ещё не применённых сообщений
  // (незавершённая проверка = «неизвестно»).
  const waitHolds = async (s, hardDeadline) => {
    for (;;) {
      const open = [...(s.holds || new Map()).entries()];
      if (!open.length) return [];
      const now = Date.now();
      const live = open.filter(([, h]) => h.deadline > now).map(([, h]) => h.deadline);
      const until = Math.min(hardDeadline, live.length ? Math.max(...live) : now);
      if (now >= until) return open.map(([, h]) => h.level);
      let timer;
      const tick = new Promise((r) => { timer = setTimeout(r, until - now); });
      try { await Promise.race([Promise.allSettled(open.map(([p]) => p)), tick]); } finally { clearTimeout(timer); }
    }
  };
  // Отправка, сбой которой не влияет на безопасность: в журнал — только код.
  const sendSafe = async (chatId, text, extra) => { try { await tg.send(chatId, text, extra); } catch (e) { logError('send', e); } };
  // Эмодзи, знаки, короткое «ок / спасибо»: модельную проверку не ждут (локальный фильтр всё равно проходят).
  const trivial = (body) => {
    const t = body.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return !t || TRIVIAL_REPLIES.has(t);
  };

  // Удержание снимается только после ПРИМЕНЕНИЯ результата (как в PR 15): проверка → синхронное применение
  // (остановка / отмена ролика) → готово. Промис никогда не отклоняется.
  function decide(chatId, s, body, level, ask = body) {
    return (async () => {
      let r;
      if (level === 'urgent') r = { kind: 'urgent' };
      else {
        try {
          const g = await track(chatId, gate.verify(s.scope, body, null, ask));
          if (g.kind === 'safety') r = { kind: 'urgent', byModel: !!g.byModel };
          else if (g.ok) r = { kind: level };
          else r = { kind: level === 'concern' || g.refusal ? 'unknown' : 'none', code: g.code }; // условие 3; отказ — как concern
        } catch { r = { kind: level === 'concern' ? 'unknown' : 'none', code: 'error' }; }
      }
      if (r.kind === 'urgent') { s.story = body; s.originalStory = body; applyStop(s); } // запрет — на это сообщение
      else if (r.kind === 'unknown') {
        // Ролика нет: отменяются все идущие доставки. fresh — отмена новая (иначе «не получилось» уже отправлено).
        r.fresh = !!s.delivering && (s.veto || 0) < (s.deliveries || 0); // ролик уже ушёл — «не получилось» не шлём
        s.veto = s.deliveries || 0;
      }
      return r;
    })();
  }

  // echo — эхо расшифровки (только при безопасном исходе, после проверки).
  // cycle — цикл согласия, в котором пришло сообщение (голосовое — до распознавания).
  async function duringRender(chatId, s, text, { echo, cycle = cycleOf(chatId) } = {}) {
    let body = String(text || '').trim();
    if (body.startsWith('/')) {
      const cmd = parseCommand(body);
      body = cmd && KNOWN_COMMANDS.has(cmd.name) ? cmd.tail : body.replace(/^\/+/, '').trim();
    }
    const own = body ? assessRisk(body).level : 'none';
    const cont = body ? continuationLevel(seenStory(s), body) : 'none';
    const level = cont !== 'none' ? cont : own;
    if (level === 'none' && trivial(body)) return consentDone(s) && !s.forgetAfter ? sendSafe(chatId, TEXT.rendering) : undefined;
    const epoch = s.deliveryEpoch || 0;
    // Самостоятельное сообщение проверяется без прежнего рассказа (QA PR 16, п. 2).
    const hold = decide(chatId, s, body, level, cont !== 'none' ? continuationContext(seenStory(s), body) : body);
    holdDelivery(s, hold, level); // синхронно, до первого await
    const r = await hold;
    if (!alive(chatId, s)) return; // /delete во время проверки: ничего не отвечаем (запрет, если был, остаётся)
    const logSafety = (extra) => Promise.resolve().then(() => writeMetric(chatId, 'safety', extra, cycle)).catch((e) => logError('metrics', e));
    if (r.kind === 'urgent') {
      // Экран остановки — первым и ни от чего не зависит: эха нет (повторять опасную фразу незачем), метрики — после.
      await sendSafe(chatId, helpMessage('urgent'));
      return logSafety({ level: 'urgent', at: 'rendering', byModel: !!r.byModel });
    }
    if (r.code) logError('check', { code: r.code });
    // Согласие отозвано, пока шла проверка: ролик не уйдёт — ни «не получилось», ни «Собираю ролик» (блок помощи — да).
    const withdrawn = !consentDone(s) || s.forgetAfter;
    if (r.kind === 'unknown') {
      if (!r.fresh || withdrawn) return; // доставка уже отменена (предел ожидания или другое сообщение): ответ уже отправлен
      if (s.delivering) s.stage = 'draft';
      return sendSafe(chatId, TEXT.tryLater());
    }
    if (r.kind === 'concern') {
      // Доставка уже отменена с «не получилось» (предел ожидания): второго ответа нет.
      if ((s.veto || 0) >= (s.deliveries || 0) && (s.deliveries || 0) > 0) return logSafety({ level: 'concern', at: 'rendering' });
      await sendSafe(chatId, helpMessage('concern'));
      return logSafety({ level: 'concern', at: 'rendering' });
    }
    // «Собираю ролик» (и эхо) — только если ролик ещё может уйти: противоречивых обещаний нет.
    const stillDelivering = () => s.delivering && consentDone(s) && !s.forgetAfter && (s.deliveryEpoch || 0) === epoch && (s.veto || 0) < (s.deliveries || 0) && s.verdict !== 'blocked';
    if (!stillDelivering()) return;
    if (echo) await sendSafe(chatId, echo); // эхо расшифровки — только при безопасном исходе и необязательно
    if (stillDelivering()) return sendSafe(chatId, TEXT.rendering);
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return; // только личные чаты: истории не для групп
    const s = session(chatId);
    const cycle = cycleOf(chatId); // цикл согласия на момент прихода: метрики голосового — в нём, а не после распознавания
    // Подпись к фото, видео, файлу — такой же текст, как сообщение (условие 1: подписи попадают в ролик и проверяются).
    // Подпись к голосовому разбирается вместе с расшифровкой ниже. Разделитель правок не может прийти от человека.
    const text = cleanInput(msg.text || (msg.voice ? '' : msg.caption) || '').trim();

    const cmd = parseCommand(text);
    const bare = cmd && !cmd.tail && KNOWN_COMMANDS.has(cmd.name) ? cmd.name : null; // «/DELETE», «/delete@бот» — как «/delete»
    // Сброс согласия — синхронно (QA PR 27, п. 1): идущая доставка сразу видит отзыв.
    // /start всегда начинает подтверждения заново: до нового согласия метрик нет, событие «start» не пишется.
    if (bare === 'start') { s.stage = 'idle'; s.period = 'day'; return startConsent(chatId, s); }
    if (bare === 'year') {
      s.stage = 'idle'; s.period = 'year';
      const logged = logMetric(chatId, 'year');
      try { return await (consentDone(s) ? tg.send(chatId, TEXT.year) : startConsent(chatId, s)); } finally { await logged; }
    }
    if (bare === 'delete') {
      sessions.delete(chatId);
      // Честный ответ (редактор 16:24): «удалены» — только если удаление сессии и статистики подтверждено.
      // Запрет safety по /delete не снимается; если они есть, полное удаление не подтверждается.
      let forgot = true;
      try { await metrics.forget(chatId); } catch { forgot = false; }
      const kinds = gate.recordsFor(`chat:${chatId}`);
      const lines = [forgot ? TEXT.deleted : TEXT.deleteFailed];
      if (kinds === null) lines.push(TEXT.recordUnknown); // намеренное сохранение не утверждаем
      else {
        const fictional = process.env.TITRY_STAND === 'fictional';
        if (fictional && kinds.has('safety')) lines.push(TEXT.keptSafety);
        // Не вымышленный стенд (срок не утверждён) или черновик/проверка ещё идут и могут поставить запрет.
        if ((kinds.size && !fictional) || inFlight.has(chatId)) lines.push(TEXT.deleteKept);
      }
      return tg.send(chatId, lines.join('\n'));
    }
    if (bare === 'help') return tg.send(chatId, TEXT.editHelp, { parse_mode: 'HTML' });
    // До 6Ж и после отказа — ничего из сообщения не обрабатывается. Исключение — уже идущая доставка ролика
    // (согласие дано раньше, повторный /start сбросил его): сообщения во время подготовки проверяются, как прежде.
    // Доставка идёт по прежнему согласию, пока его не отозвали; после отзыва — те же правила, что до 6Ж.
    const busy = s.delivering && !(s.forgetAfter && s.forgetGen === s.draftId);
    if (!consentDone(s)) {
      // Решение Claude 18.11, п. 6: явная опасность и до подтверждений получает экран остановки с 112 и контактами.
      // Только локальный фильтр: без модели, без записи в сессию, журнал и метрики.
      const caption = msg.voice && typeof msg.caption === 'string' ? cleanInput(msg.caption).trim() : '';
      if (assessRisk(text || caption).level === 'urgent') return tg.send(chatId, helpMessage('urgent'));
      return preConsent(chatId, s);
    }

    if (msg.voice) {
      const voiceRefused = !sttAvailable() && transcribe === transcribeOgg ? TEXT.voiceOff : msg.voice.duration > MAX_VOICE_SECONDS ? TEXT.voiceLong : null;
      const caption = typeof msg.caption === 'string' ? cleanInput(msg.caption).trim() : ''; // подпись к голосовому — тоже текст
      // Подпись проходит локальный фильтр синхронно, ДО распознавания (КРИТИКА PR 16, п. 1): явный сигнал — сразу путь
      // остановки, без ожидания и без зависимости от распознавания.
      const captionLevel = caption ? assessRisk(caption).level : 'none';
      if (busy) {
        // Голосовое в окне до отправки (условие 2). Не распознано — ролик не отменяется: «не получилось разобрать голосовое, напиши текстом»;
        // подпись проверяется как текст. Распознанное держит доставку с начала распознавания (как в PR 15).
        if (captionLevel === 'urgent') return duringRender(chatId, s, caption, { cycle }); // ролик отменяется сейчас
        if (voiceRefused) return caption ? Promise.all([sendSafe(chatId, TEXT.notHeard), duringRender(chatId, s, caption, { cycle })]) : sendSafe(chatId, TEXT.notHeard);
        let releaseVoice;
        // Уровень удержания — уровень подписи: concern подписи держит «неизвестно» до конца проверки (не none).
        holdDelivery(s, new Promise((r) => { releaseVoice = r; }), captionLevel, Infinity);
        try {
          let story = '';
          try {
            Promise.resolve().then(() => tg.action(chatId, 'typing')).catch((e) => logError('send', e)); // не ждём
            // Согласие сменилось или сессию удалили, пока скачивался файл: распознавание не запускается (QA PR 31 be03e4e);
            // между получением пути и запросом байтов — аудио не запрашивается (QA PR 31 9649b27).
            const buf = await tg.fileBuffer(msg.voice.file_id, { ready: () => sameConsent(chatId, s, cycle) });
            if (buf === null || !sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, caption);
            story = cleanInput(await transcribe(buf, { duration: msg.voice.duration }));
          } catch (e) { logError('stt', e); }
          story = String(story || '').trim();
          if (!alive(chatId, s)) return;
          if (!sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, story ? withCaption(story, caption) : caption);
          if (!story) {
            const p = caption ? duringRender(chatId, s, caption, { cycle }) : null; // удержание подписи ставится синхронно
            releaseVoice();
            await sendSafe(chatId, TEXT.notHeard);
            return await p;
          }
          // duringRender ставит своё удержание синхронно; внешнее снимаем сразу — эхо и typing ожидание не держат.
          const p = duringRender(chatId, s, withCaption(story, caption), { echo: `Расшифровка:\n«${story}»`, cycle });
          releaseVoice();
          return await p;
        } finally { releaseVoice(); }
      }
      if (captionLevel === 'urgent') return handleStory(chatId, s, caption, 'text', cycle); // остановка без распознавания
      if (voiceRefused) {
        await tg.send(chatId, voiceRefused);
        return caption ? handleStory(chatId, s, caption, 'text', cycle) : undefined; // подпись — тот же путь, что текст
      }
      await tg.action(chatId, 'typing');
      // Граница скачивания и распознавания (QA PR 31 be03e4e): согласие сменилось или сессию удалили — ни скачивания,
      // ни распознавания; во время скачивания — распознавание не запускается.
      if (!sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, caption);
      let story = '';
      try {
        const buf = await tg.fileBuffer(msg.voice.file_id, { ready: () => sameConsent(chatId, s, cycle) });
        if (buf === null || !sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, caption);
        story = cleanInput(await transcribe(buf, { duration: msg.voice.duration }));
      } catch (e) { logError('stt', e); }
      if (!alive(chatId, s)) return; // /delete во время распознавания: ничего не отвечаем
      if (!sameConsent(chatId, s, cycle)) return outsideConsent(chatId, s, story ? withCaption(story, caption) : caption);
      if (!story) {
        await tg.send(chatId, TEXT.voiceEmpty);
        return caption ? handleStory(chatId, s, caption, 'text', cycle) : undefined;
      }
      // Подпись к голосовому — продолжение рассказа: те же проверки на всём, что может попасть в ролик.
      const full = withCaption(story, caption);
      await tg.send(chatId, `Расшифровка:\n«${story}»`);
      return handleStory(chatId, s, full, 'voice', cycle);
    }

    if (busy && !text) {
      // Кружок, аудио, видео, стикер, фото во время подготовки: ролик не отменяется (условие 2). Подпись — как текст.
      const caption = typeof msg.caption === 'string' ? cleanInput(msg.caption).trim() : '';
      if (caption) return duringRender(chatId, s, caption, { cycle });
      return sendSafe(chatId, msg.video_note || msg.audio || msg.video ? TEXT.notHeard : TEXT.rendering);
    }
    if (!text) return;
    if (busy) return duringRender(chatId, s, text, { cycle });
    // Пустая заготовка после нехватки: первая правка открывает черновик (рассказ уже прошёл ту же проверку,
    // что перед репликой нехватки: остановка → технические исходы → нехватка).
    if (s.stage === 'compose' && s.skeleton && !s.episode && parseEdit(text)) {
      const original = s.originalStory || s.story;
      // Рассказ, который тем временем запрещён, черновика не открывает: карточка помощи (восьмой разбор).
      if (isBlocked(s, original) || gate.status(s.scope, original).kind === 'safety') return stopForSafety(chatId, s, 'urgent', { at: 'late' });
      if (gate.status(s.scope, original).kind) { s.skeleton = null; s.stage = 'idle'; return tg.send(chatId, TEXT.checkUnavailable); }
      s.episode = s.skeleton; s.skeleton = null; s.verdict = 'ok'; s.edits = 0; s.stage = 'draft';
    }
    if ((s.stage === 'draft' || s.stage === 'watched') && s.episode) {
      const cmd = parseEdit(text);
      if (cmd) {
        // Решение владельца 11.11 12:05, п. 1: правка — такой же вход, как рассказ. Её текст проходит тот же фильтр
        // остановки в контексте всего рассказа (рассказ + прежние правки + эта) ДО разбора правки: ошибка номера строки
        // или лимита не пропускает текст мимо фильтра (разбор 940f41cc). Опора и контекст — только в памяти сессии;
        // текст правки не пишется ни в журнал, ни в метрики (там — только уровень и место).
        const own = editCorpus(cmd);
        // Правка — отдельная фраза контекста: без точки она склеилась бы с соседним текстом в одну часть; от рассказа она
        // отделена EDIT_SEP (PR 13): признаки рассказа на неё не переходят, фильтр видит рассказ и правку вместе.
        const ownDot = own && (/[.!?…]$/.test(own) ? own : `${own}.`);
        const ctx = own ? `${s.story}${EDIT_SEP}${ownDot}` : s.story; // хранимый рассказ, предел длины — по нему
        const seen = own ? `${seenStory(s)}${EDIT_SEP}${ownDot}` : seenStory(s); // проверки безопасности — по нему
        let concern = false;
        if (own) {
          // Для проверок безопасности правки — продолжение рассказа (joinEdits, PR 13): «Я хочу» + правка «умереть».
          const prevLevel = assessRisk(joinEdits(seenStory(s))).level;
          const risk = assessRisk(joinEdits(seen));
          if (risk.level === 'urgent') { s.story = seen; return stopForSafety(chatId, s, 'urgent', { at: 'edit' }); }
          // concern, который внесла сама правка: строка не берётся, рядом — тот же блок помощи, что у рассказа с concern
          // (одним сообщением, как в PR 11). Реплики нехватки здесь нет: прежний черновик остаётся.
          // Если рассказ уже был concern, блок помощи человек видел вместе с черновиком: правка, которая сама по себе
          // none, отклоняется ниже правилом титров без повторного блока (четвёртый разбор, мелочь 3).
          concern = risk.level === 'concern' && (prevLevel === 'none' || assessRisk(own).level !== 'none');
          // Предел рассказа (6000, как у draft.js) действует и с правками: иначе каждая правка удлиняет то, что проверяет
          // фильтр. Остановка выше уже отработала; concern-правка получает тот же блок помощи, что исключённая.
          if (ctx.length > STORY_MAX) {
            // Окно отклонённых правок — целые правки, не длиннее STORY_MAX: проверки остаются ограниченными по времени.
            s.overflow = [...(s.overflow || []), ownDot];
            while (s.overflow.length > 1 && s.overflow.join(EDIT_SEP).length > STORY_MAX) s.overflow.shift();
            if (!concern) return tg.send(chatId, TEXT.tooLong);
            await logMetric(chatId, 'edit_excluded', { level: 'concern' });
            for (const t of editExcludedMessages(true, { path: editedPath(cmd, s.episode) })) await tg.send(chatId, t);
            return;
          }
        }
        const before = structuredClone(s.episode);
        if (!concern) {
          const err = applyEdit(s.episode, cmd);
          if (err) return tg.send(chatId, err);
        }
        let excluded = concern;
        if (own) {
          s.story = ctx;
          // п. 2: «угроза не в титрах» — и для фраз из словаря угроз, которые фильтр остановки пропустил как гиперболу;
          // п. 3 для правок: местоимение в строке правки, указывающее на человека из исключённой угрозы.
          const path = editedPath(cmd, s.episode);
          const joined = joinEdits(seen);
          if (!excluded && path && (threatErrors(joined, s.episode).some((e) => e.path === path)
            || (/^(?:rows\.|post$)/.test(path) && threatPronounFilter(joined)(own)))) excluded = true;
          if (excluded) s.episode = before;
          // Один вердикт на правку: та же проверка, что перед рендером (рассказ + поля эпизода). Если она даёт urgent,
          // остановка сейчас, а не обещание «черновик на месте» и остановка на «Смотреть».
          if (assessEpisodeRisk(joined, s.episode).level === 'urgent') return stopForSafety(chatId, s, 'urgent', { at: 'edit' });
          if (excluded) {
            await logMetric(chatId, 'edit_excluded', { level: concern ? 'concern' : 'none' });
            for (const t of editExcludedMessages(concern, { path })) await tg.send(chatId, t);
            return;
          }
        }
        s.edits = (s.edits || 0) + 1;
        s.stage = 'draft';
        return showDraft(chatId, s);
      }
      // Короткая начатая, но не разобранная правка («2:», «+ окно»): подсказка вместо «подробнее», черновик остаётся.
      // Только короткий текст — тот же путь shortText с теми же проверками безопасности; длинный идёт путём рассказа, как раньше.
      if (text.length < 12 && EDIT_START.test(text)) return shortText(chatId, s, text, TEXT.editUnparsed);
    }
    // «/текст» (решение Claude 11.11 15:05 п. 1): известная команда без хвоста обработана выше; у известной команды
    // с хвостом проверяется хвост, любой другой текст на «/» — путь рассказа (проверка безопасности первой).
    let body = text;
    if (text.startsWith('/')) {
      // Известная команда без хвоста обработана выше; у известной команды с хвостом проверяется хвост.
      // Команда другому боту: без хвоста — не нам и не рассказ; хвост — как текст (проверка безопасности первой).
      const foreign = !cmd && /^\/[A-Za-z]+@\w+(?:\s+([\s\S]*))?$/.exec(text);
      body = foreign ? (foreign[1] || '').trim() : cmd && KNOWN_COMMANDS.has(cmd.name) ? cmd.tail : text.replace(/^\/+/, '').trim();
      if (!body) return; // «/», «//» — не команда и не рассказ: без ответа
    }
    if (body.length < 12) return shortText(chatId, s, body);
    return handleStory(chatId, s, body, 'text');
  }

  // Короткий текст (< 12 знаков; PR 15): локальный фильтр ≠ none → путь рассказа (остановка и помощь, без «подробнее»);
  // иначе — «Расскажи чуть подробнее». Модельной проверки коротких текстов нет (решение владельца кода 13.11 15:00):
  // модельная проверка одна — перед рендером. Текст в журнал и метрики не пишется.
  async function shortText(chatId, s, text, reply = TEXT.more) {
    // Запрещённый раньше текст (например, моделью в окне до отправки) — снова остановка, а не «подробнее».
    // Строчное продолжение бытовой формы (решение 16.11, (б)) — и для коротких сообщений: «и ядом» после «Отравлюсь шавермой.».
    if (assessRisk(text).level !== 'none' || continuationLevel(seenStory(s), text) !== 'none' || isBlocked(s, text) || gate.status(s.scope, text).kind === 'safety') return handleStory(chatId, s, text, 'text');
    return tg.send(chatId, reply);
  }

  async function onCallback(q) {
    const chatId = q.message && q.message.chat.id;
    await tg.answer(q.id);
    if (!chatId) return;
    const s = session(chatId);
    const data = q.data || '';
    if (data.startsWith('cs:')) return onConsent(chatId, s, data);
    if (data.startsWith('fb:')) {
      const [, v, cycle] = data.split(':');
      // Только значения показанных кнопок (fit, miss, heavier): иное значение не пишется в метрики и ничего не отвечает.
      if (!FEEDBACK_VALUES.has(v)) return;
      // Отклик на ролик прежнего согласия (после /delete, /start, отказа) в метрики не пишется; ответ на одну из трёх кнопок — как обычно.
      if (cycle && cycle === String(s.consent?.cycle)) await logMetric(chatId, 'feedback', { value: v });
      if (v === 'heavier') { await tg.send(chatId, TEXT.heavier); return tg.send(chatId, helpMessage('concern')); }
      return tg.send(chatId, v === 'fit' ? TEXT.fit : TEXT.miss);
    }
    if (data === 'edit') return tg.send(chatId, TEXT.editHelp, { parse_mode: 'HTML' });
    // Кнопки черновика до 6Ж и после отказа (повторный /start, /delete, истёкшая сессия) — ничего не делают,
    // и во время доставки тоже: старая ▶ не запускает второй ролик. Остановленный рассказ (stage help) — экран помощи.
    if (!consentDone(s) && s.stage !== 'help') return;
    const [action, idPart] = data.split(':');
    if (s.stage === 'rendering') return tg.send(chatId, TEXT.rendering);
    // Кнопка работает только для текущего черновика, прошедшего проверку безопасности.
    const current = s.episode && s.verdict === 'ok' && (s.stage === 'draft' || s.stage === 'watched') && Number(idPart) === s.draftId;
    if (!current) return tg.send(chatId, s.stage === 'help' ? helpMessage('urgent') : TEXT.noDraft);
    if (action === 'play') return doRender(chatId, s);
    if (action === 'mood') { s.episode.mood = MOOD_ORDER[(MOOD_ORDER.indexOf(s.episode.mood) + 1) % MOOD_ORDER.length]; s.stage = 'draft'; return showDraft(chatId, s); }
    if (action === 'music') { s.episode.music = MUSIC_ORDER[(MUSIC_ORDER.indexOf(s.episode.music) + 1) % MUSIC_ORDER.length]; s.stage = 'draft'; return showDraft(chatId, s); }
  }

  // Исправленное сообщение (КРИТИКА 14.11, п. 4): правка проходит локальный фильтр, как новое сообщение. Явная
  // опасность — ролик отменяется (в окне доставки), черновик уничтожается, экран остановки. В рассказ правка
  // не попадает и других ответов не даёт: исправленный текст ролик не меняет. Текст в журнал и метрики не пишется.
  // Без действующего согласия (до 6Ж, после отказа, после повторного /start — в том числе во время доставки, которая
  // тогда уже не отправит ролик) — только экран остановки, без записи в сессию и метрики (QA PR 27, п. 3).
  async function onEdited(msg) {
    if (!msg.chat || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = cleanInput(msg.text || msg.caption || '').trim();
    if (!text || assessRisk(text).level !== 'urgent') return;
    const prev = sessions.get(chatId);
    // До подтверждений и после отказа (в том числе во время идущей доставки) — только экран остановки (п. 6),
    // без записи в сессию, журнал и метрики (QA PR 27, п. 3).
    if (!prev || !consentDone(prev)) return tg.send(chatId, helpMessage('urgent'));
    const s = session(chatId);
    s.story = text; s.originalStory = text;
    return stopForSafety(chatId, s, 'urgent', { at: s.delivering ? 'edited_rendering' : 'edited' });
  }

  async function handleUpdate(u) {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.edited_message) await onEdited(u.edited_message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { logError('update', e); }
  }

  return { handleUpdate, sessions, sweep };
}

// ── Транспорт Telegram Bot API ───────────────────────────────────────────────

export function telegram(token, { callMs = TELEGRAM_CALL_MS } = {}) {
  const base = `https://api.telegram.org/bot${token}`;
  // Предел ожидания приложения для каждого вызова API (решение Claude 12.11 20:00): зависший вызов не держит ветку.
  // getUpdates — длинный опрос (30 с) с запасом; sendVideo — загрузка файла; остальное — TELEGRAM_CALL_MS.
  const limitFor = (method) => (method === 'getUpdates' ? 45_000 : method === 'sendVideo' ? 120_000 : callMs);
  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(limitFor(method)),
    });
    const data = await res.json().catch(() => ({}));
    // status — код Telegram (401/403/429…): по нему оператор различает причину в обезличенном журнале.
    if (!data.ok) throw Object.assign(new Error(`Telegram ${method}: ${data.description || res.status}`), { status: data.error_code || res.status });
    return data.result;
  }
  return {
    call,
    send: (chat_id, text, extra = {}) => call('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra }),
    action: (chat_id, action) => call('sendChatAction', { chat_id, action }).catch(() => {}),
    answer: (id) => call('answerCallbackQuery', { callback_query_id: id }).catch(() => {}),
    // ready() — проверка между получением пути (getFile) и запросом байтов: false — аудио не запрашивается, null.
    async fileBuffer(file_id, { ready } = {}) {
      const f = await call('getFile', { file_id });
      if (ready && !(await ready())) return null;
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Telegram file ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    // ready() — проверка (может быть асинхронной) после чтения файла: false — запроса нет, видео не отправляется.
    async sendVideo(chat_id, file, extra = {}, { ready } = {}) {
      const form = new FormData();
      form.append('chat_id', String(chat_id));
      form.append('supports_streaming', 'true');
      for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      form.append('video', new Blob([await fs.readFile(file)], { type: 'video/mp4' }), 'titry.mp4');
      if (ready && !(await ready())) return null;
      return call('sendVideo', form);
    },
  };
}

/**
 * Подготовка до приёма задач (B09.6, решение владельца 17:10 и 18:05): очистка остатков голосовых и загрузка
 * хранилища запретов. Любая ошибка — исключение: вызывающий не начинает опрос Telegram (fail closed).
 * Нет ключа хранилища — тоже отказ запуска, а не тихий режим.
 */
/**
 * Стартовая очистка data/tmp: ролики бота (*.mp4) прежнего процесса — в их имени хэш человека, в кадре титры
 * по рассказу. Вызывается до приёма задач, поэтому все такие файлы старше запуска. Каталог-ссылка или не каталог —
 * ошибка (запуск останавливается); ссылки внутри удаляются как ссылки, цели не трогаются; подкаталоги не трогаются.
 */
// Каталог роликов бота: data/tmp рабочей копии или TITRY_BOT_TMP_DIR (тесты указывают временный каталог,
// чтобы не трогать ролики работающего бота).
export const botTmpDir = () => process.env.TITRY_BOT_TMP_DIR || path.join(ROOT, 'data', 'tmp');
// Требование: один процесс бота на рабочую копию (два процесса и так конфликтуют в getUpdates). Второй процесс
// при запуске удалил бы ролики первого, которые ещё рендерятся или отправляются.
export async function purgeBotTmp(dir = botTmpDir()) {
  let st;
  try { st = await fs.lstat(dir); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  if (st.isSymbolicLink()) throw Object.assign(new Error('data/tmp — ссылка'), { code: 'EACCES' });
  if (!st.isDirectory()) throw Object.assign(new Error('data/tmp — не каталог'), { code: 'ENOTDIR' });
  let removed = 0;
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (!d.name.endsWith('.mp4') || !(d.isFile() || d.isSymbolicLink())) continue;
    await fs.rm(path.join(dir, d.name), { force: true });
    removed++;
  }
  return removed;
}

export async function prepareBot({ checkRender = checkRenderer, cleanup = cleanupVoiceOrphans, cleanupTmp = purgeBotTmp, ledger, helpFile, env = process.env, log = console.error, texts = { CONSENT_TEXT, TEXT } } = {}) {
  if (!env.METRICS_SALT || String(env.METRICS_SALT).trim().length < METRICS_SALT_MIN) {
    logError('metrics.salt', { code: 'metrics_salt' });
    throw Object.assign(new Error('startup'), { code: 'metrics_salt', stage: 'metrics.salt' });
  }
  // Нет ключа API: при TITRY_RELEASE_REAL_DATA=1 — отказ старта; иначе одна строка в журнал (условие 4).
  try { modelModeAtStart({ env, log }); } catch (e) { logError('model.key', e); throw e; }
  // Контакты помощи: без проверенного блока помощи бот не стартует (решение владельца 11:05).
  try { prepareHelp(helpFile); } catch (e) { logError('help.load', e); throw Object.assign(new Error('startup'), { code: 'help_config', stage: 'help.load' }); }
  // Предмортем G0, п. 1: на реальных данных тексты участнику (согласие и реплики бота) — окончательные; иначе отказ
  // старта до очистки и приёма сообщений. После prepareHelp: реплики с блоком помощи собираются из проверенных
  // контактов. В журнал — только код и ключи текстов, без их содержимого.
  if (env.TITRY_RELEASE_REAL_DATA === '1') {
    let keys;
    try { keys = unfinishedTexts(texts); } catch (e) { logError('release.texts', e); throw Object.assign(new Error('startup'), { code: 'release_texts', stage: 'release.texts' }); }
    if (keys.length) {
      log(JSON.stringify({ at: new Date().toISOString(), level: 'error', stage: 'release.texts', code: 'release_texts', keys }));
      throw Object.assign(new Error('startup'), { code: 'release_texts', stage: 'release.texts' });
    }
  }
  // Без Playwright или ffmpeg бот принял бы рассказы, но не собрал бы ни одного ролика.
  try { await checkRender({ env }); } catch (e) { logError('render.check', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'render.check' }); }
  try { await cleanup(); } catch (e) { logError('voice.cleanup', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'voice.cleanup' }); }
  try {
    const removed = await cleanupTmp();
    // Только этап и число, без путей и имён; формат строки — как у журнала ошибок.
    if (removed) log(JSON.stringify({ at: new Date().toISOString(), level: 'info', stage: 'tmp.cleanup', removed }));
  } catch (e) { logError('tmp.cleanup', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'tmp.cleanup' }); }
  const l = ledger || processLedger('bot', path.join(ROOT, 'data', 'state'));
  // ledger_missing — файл запретов пропал после инициализации (план Критика 20.11, п. 5): старт закрыт до восстановления.
  try { await l.load(); } catch (e) { logError('ledger.load', e); throw Object.assign(new Error('startup'), { code: e?.code === 'ledger_missing' ? 'ledger_missing' : 'ledger', stage: 'ledger.load' }); }
  return l;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('Задайте TELEGRAM_BOT_TOKEN (выдаёт @BotFather).'); process.exit(2); }
  let ledger;
  try { ledger = await prepareBot(); } catch {
    console.error(`Запуск остановлен: не задана METRICS_SALT (не короче ${METRICS_SALT_MIN} знаков), нет ключа модели или тексты для участника (согласие, реплики бота) не окончательные при TITRY_RELEASE_REAL_DATA=1, не проверены контакты помощи (config/help.json), не найден Playwright, не запускается Chromium (TITRY_CHROMIUM) или ffmpeg (FFMPEG), не подтверждена очистка временных файлов или хранилище запретов (${KEY_ENV}, ${KEY_VERSION_ENV}). Задачи не принимаются. Остатки tmp и файл хранилища не удаляйте вручную без владельца кода.`);
    process.exit(3);
  }
  const tg = telegram(token);
  const me = await tg.call('getMe');
  await tg.call('setMyCommands', { commands: [
    { command: 'start', description: 'Как это работает' },
    { command: 'year', description: 'Титры 2026 года' },
    { command: 'help', description: 'Как поправить строку' },
    { command: 'delete', description: 'Запросить удаление данных' },
  ] }).catch(() => {});
  console.log(`Бот @${me.username} запущен. Распознавание речи: ${sttAvailable() ? 'SpeechKit' : 'выключено'}.`);
  const bot = createBot({ tg, ledger, renderTimeoutMs: renderTimeoutFromEnv(), botName: me.username });
  setInterval(bot.sweep, 10 * 60 * 1000).unref();
  // Снимок состояния для внешнего наблюдателя (Б6 п. 5): раз в минуту, без номеров и текстов; отправок наружу нет.
  const health = makeHealth();
  const healthFile = path.join(ROOT, 'data', 'health.json');
  const snap = () => writeHealth(healthFile, health.snapshot({ stateHealthy: ledger.healthy() })).catch((e) => logError('health', e));
  snap();
  setInterval(snap, 60 * 1000).unref();
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'edited_message', 'callback_query'] });
      health.pollOk();
      for (const u of updates) {
        offset = u.update_id + 1;
        bot.handleUpdate(u); // не ждём: рендер одного пользователя не блокирует ответы другим
      }
    } catch (e) {
      logError('poll', e);
      health.pollFailed();
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Необработанные ошибки — тоже обезличенно: иначе Node напечатает стек с сообщением целиком.
  process.on('unhandledRejection', (e) => logError('unhandled', e));
  process.on('uncaughtException', (e) => { logError('uncaught', e); process.exit(1); });
  main().catch((e) => { logError('main', e); process.exit(1); });
}
