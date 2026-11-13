// Telegram-бот «Титры»: голосовое или текст → черновик титров → правка → MP4 9:16 в чат.
// Без внешних зависимостей для Telegram: Bot API через fetch, long polling.
// Запуск: TELEGRAM_BOT_TOKEN=... npm run bot
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, LIMITS, creditRows, dateLabel, todayIso, validateEpisode, PERIODS, episodeToText, EDIT_SEP, cleanInput, joinEdits } from '../engine/episode.js';
import { makeDraft, draftRuleBased, modelSafetyCheck, hasClaudeCredentials, pairFromSentence } from './draft.js';
import { makeGate } from './gate.js';
import { helpMessage, prepareHelp, assessRisk, assessEpisodeRisk, validateSafeEpisode, threatErrors, threatPronounFilter, INSUFFICIENT_TEXT, INSUFFICIENT_INVITE_TEXT, INSUFFICIENT_AFTER_EXCLUSION, INSUFFICIENT_MATERIAL, EDIT_NOT_IN_TITLES_TEXT, editNotInTitlesText, TELEGRAM_TEXT_LIMIT } from './safety.js';
import { renderEpisode, ROOT } from './render.js';
import { logError, safeCode } from './errlog.js';
import { transcribeOgg, sttAvailable, MAX_VOICE_SECONDS, cleanupVoiceOrphans } from './stt.js';
import { makeLedger, KEY_ENV, KEY_VERSION_ENV } from './ledger.js';

const MOOD_ORDER = ['warm', 'sad', 'anger', 'quiet'];
const MUSIC_ORDER = ['warm', 'sad', 'anger', 'quiet', 'none'];
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const WATERMARK = process.env.BOT_WATERMARK ?? 'сделано в титрах';

export const TEXT = {
  start: [
    'Это «Титры».',
    'Расскажи голосом или текстом, что было сегодня. Можно сумбурно, одного момента достаточно. В ответ придут короткие титры твоего дня с музыкой, как в конце фильма.',
    'Ничего не публикуется. Рассказ нужен только чтобы собрать титры и не хранится после этого.',
    'Только для взрослых (18+).',
    '/year — титры 2026 года\n/delete — запросить удаление данных',
  ].join('\n\n'),
  year: 'Расскажи про свой 2026 год за минуту: что случилось, кто был рядом, что осталось с тобой. Можно голосом.',
  working: 'Монтирую…',
  rendering: 'Собираю ролик. Обычно это меньше минуты.',
  queue: (n) => `Собираю ролик. Перед тобой в очереди: ${n}.`,
  // ИР-04: очередь заполнена, черновик сохранён. Текст редактора повествования (10.11), дословно.
  busy: 'Сейчас очередь заполнена. Черновик остаётся здесь. Нажми «▶ Смотреть титры» ещё раз чуть позже.',
  voiceOff: 'Голосовые пока не подключены. Напиши, пожалуйста, текстом.',
  voiceLong: `Голосовое длиннее ${Math.round(MAX_VOICE_SECONDS / 60)} минут. Для одной сцены хватит минуты.`,
  voiceEmpty: 'Не получилось разобрать голосовое. Можно повторить или написать текстом.',
  editExcluded: EDIT_NOT_IN_TITLES_TEXT, // текст — в server/safety.js; окончательный утверждает редактор
  editHelp: [
    'Как поправить:',
    '<code>2: вечером гуляла в парке</code> — новая строка 2 из твоих слов',
    '<code>2: Вечером — гуляла в парке</code> — роль и текст',
    '<code>-3</code> — убрать строку 3',
    '<code>+ Ночью — смотрела в окно</code> — добавить строку',
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
  keptTechnical: 'Служебная запись о технической приостановке сохранена по правилу теста. В ней нет текста рассказа. [срок не утверждён]',
  recordUnknown: 'Проверить состояние служебной записи не получилось. Полное удаление не подтверждено.',
  // ИР-02: проверка недоступна — текст редактора повествования (PM-01, 9.11) дословно. Без срока и без карточки помощи.
  checkUnavailable: 'Ролик задерживается: сервис не завершил проверку. Сейчас отправить его не получится. Ждать в чате и отвечать на это сообщение не нужно.',
  // Техническая приостановка — редактор повествования 14:42, принято владельцем 15:08, дословно.
  checkPaused: 'Сервис дважды не смог завершить проверку рассказа. Сейчас ролик не создаётся. Ждать в чате и отвечать на это сообщение не нужно.',
  // Черновик текста, на вычитку редактору повествования: честно, без «всё удалено», без обещаний сроков.
  deleteFailed: 'Сессия удалена, а удаление статистики по тебе подтвердить не получилось. Попробуй /delete ещё раз чуть позже.',
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
    default: return 'Не понял правку.';
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
  lines.push('', 'Похоже на твой день? Любую строку можно поправить.');
  return lines.join('\n');
}

export function draftKeyboard(ep, draftId = 0) {
  const nextMood = MOODS[MOOD_ORDER[(MOOD_ORDER.indexOf(ep.mood) + 1) % MOOD_ORDER.length]];
  const nextMusic = TRACKS[MUSIC_ORDER[(MUSIC_ORDER.indexOf(ep.music) + 1) % MUSIC_ORDER.length]];
  return {
    inline_keyboard: [
      [{ text: '▶ Смотреть титры', callback_data: `play:${draftId}` }],
      [{ text: `Плёнка: ${nextMood.film}`, callback_data: `mood:${draftId}` }, { text: `Музыка: ${nextMusic.file ? nextMusic.title : 'тишина'}`, callback_data: `music:${draftId}` }],
      [{ text: 'Как поправить строку', callback_data: 'edit' }],
    ],
  };
}

const FEEDBACK_KB = {
  inline_keyboard: [[
    { text: 'Попало', callback_data: 'fb:fit' },
    { text: 'Не подходит', callback_data: 'fb:miss' },
    { text: 'Стало тяжелее', callback_data: 'fb:heavier' },
  ]],
};

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
    async log(chatId, event, extra = {}) {
      const h = hash(chatId);
      enter(h);
      try {
        const gen = generation.get(h) || 0;
        const row = JSON.stringify({ at: new Date().toISOString(), user: h, event, ...extra }) + '\n';
        await fs.mkdir(path.dirname(file), { recursive: true });
        return await serialClean(async () => {
          if ((generation.get(h) || 0) !== gen) return; // человек удалил данные, пока запись ждала
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

// ── Логика бота (транспорт подменяется в тестах) ─────────────────────────────

export function createBot({
  tg, metrics = makeMetrics(), draft = makeDraft, render = renderEpisode, transcribe = transcribeOgg, now = () => new Date(),
  // Отдельная проверка перед рендером (контракт владельца 10.11 12:05 / 13:05): true — опасно, false — разрешение,
  // исключение — проверка не завершена. Нет ключа — проверка недоступна, ролик не собирается.
  safetyCheck, hasKey = safetyCheck ? () => true : hasClaudeCredentials, monoNow, wallNow,
  ledger = null, // хранилище запретов (server/ledger.js); область — участник, производная HMAC на диске
  gate = makeGate({ check: safetyCheck || ((text) => modelSafetyCheck(text)), hasKey, monoNow, wallNow, ledger }),
} = {}) {
  const sessions = new Map();
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
    // но не снимает ни safety, ни technical (решение владельца 15:08 / 16:00). На диск — только HMAC области.
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
  async function stopForSafety(chatId, s, level, extra = {}) {
    s.episode = null;
    s.skeleton = null;
    s.verdict = 'blocked';
    s.draftId = (s.draftId || 0) + 1; // кнопки всех прежних черновиков перестают работать
    s.stage = 'help';
    if (s.story) {
      s.blocked = s.blocked || new Set();
      s.blocked.add(storyKey(s.originalStory || s.story));
      gate.markSafety(s.scope, s.originalStory || s.story);
    }
    await metrics.log(chatId, 'safety', { level, ...extra });
    await tg.send(chatId, helpMessage('urgent'));
  }

  // Сессия ещё та же: не удалена через /delete и не заменена новой после истечения срока.
  const alive = (chatId, s) => sessions.get(chatId) === s;
  const isBlocked = (s, story) => !!(s.blocked && s.blocked.has(storyKey(story)));

  async function handleStory(chatId, s, story, source) {
    // Новый рассказ сразу отменяет прежний черновик: его кнопки больше ничего не запускают.
    s.episode = null;
    s.skeleton = null;
    s.verdict = null;
    s.draftId = (s.draftId || 0) + 1;
    const gen = s.draftId; // поколение: результат ожидания применяется, только если оно всё ещё текущее
    s.story = story;
    s.originalStory = story;
    s.stage = 'drafting';
    const prior = gate.status(s.scope, story);
    if (isBlocked(s, story) || prior.kind === 'safety') {
      return stopForSafety(chatId, s, 'urgent', { at: 'repeat' });
    }
    if (prior.kind) {
      // technical или хранилище недоступно: черновик не делается, без карточки помощи.
      logError('check', { code: prior.kind === 'technical' ? 'check_incomplete_twice' : prior.code });
      s.stage = 'idle';
      return tg.send(chatId, prior.kind === 'technical' ? TEXT.checkPaused : TEXT.checkUnavailable);
    }
    const current = () => alive(chatId, s) && s.draftId === gen && !isBlocked(s, story) && gate.status(s.scope, story).kind !== 'safety';
    await tg.action(chatId, 'typing');
    await tg.send(chatId, TEXT.working);
    let r;
    try {
      // Черновик — незавершённое решение по рассказу: соседняя проверка того же рассказа ждёт его (gate.holdDraft).
      r = await track(chatId, gate.holdDraft(s.scope, story, draft(story, { date: todayIso(now()), period: s.period, tone: 'quiet' })));
    } catch (e) {
      logError('draft', e);
      if (!current()) return;
      s.stage = 'idle';
      await tg.send(chatId, TEXT.draftFail);
      return;
    }
    // Опасный черновик, пришедший после /delete или смены сессии: запрет участника записывается всё равно
    // (область — чат, а не сессия), но в чат ничего не отправляется.
    if (r && !r.unavailable && !r.insufficient && !r.episode) gate.markSafety(`chat:${chatId}`, story);
    if (!alive(chatId, s)) return; // удалённая сессия не оживает из отложенного ответа
    if (r.unavailable) {
      // ИР-02: проверка не завершена — техническое состояние, не остановка: рассказ не запоминается
      // как запрещённый, карточка помощи не показывается, черновика и ролика нет.
      logError('draft', { code: r.code });
      if (!current()) return;
      s.stage = 'idle';
      return tg.send(chatId, TEXT.checkUnavailable);
    }
    if (r.insufficient) return replyInsufficient(chatId, s, story, gen, current, r.risk && r.risk.level === 'concern', r.code);
    if (!r.episode) {
      // Остановка важнее всего, даже если ответ устарел: рассказ запоминается как запрещённый.
      if (s.draftId === gen) return stopForSafety(chatId, s, r.risk.level, { byModel: r.risk.byModel });
      s.blocked = s.blocked || new Set();
      s.blocked.add(storyKey(story));
      gate.markSafety(s.scope, story);
      // Если сейчас в работе тот же рассказ, его черновик тоже уничтожается.
      if (s.verdict !== 'blocked' && s.originalStory && storyKey(s.originalStory) === storyKey(story)) {
        return stopForSafety(chatId, s, r.risk.level, { byModel: r.risk.byModel, at: 'late' });
      }
      return;
    }
    if (!current()) {
      // Устаревший «можно» молча отбрасывается. Но если тот же рассказ этой сессии тем временем остановлен
      // (например, проверкой прежней сессии до /delete), человек получает карточку помощи, а не тишину.
      if (alive(chatId, s) && s.verdict !== 'blocked' && s.originalStory && storyKey(s.originalStory) === storyKey(story)
        && (isBlocked(s, story) || gate.status(s.scope, story).kind === 'safety')) return stopForSafety(chatId, s, 'urgent', { at: 'late' });
      return;
    }
    await metrics.log(chatId, 'story', { source, period: s.period, chars: Math.round(story.length / 50) * 50 });
    if (!current()) return;
    if (r.risk.level === 'concern') await tg.send(chatId, helpMessage('concern'));
    if (!current()) return;
    s.episode = r.episode;
    s.verdict = 'ok';
    s.edits = 0;
    s.stage = 'draft';
    await metrics.log(chatId, 'draft', { provider: r.provider, rows: r.episode.rows.length, dropped: (r.dropped || []).length });
    if (!current()) return;
    await showDraft(chatId, s);
  }

  // Нехватка материала после исключения опасных частей (insufficient_after_exclusion). Порядок исходов:
  // stop (safety) → техническая недоступность/пауза → [явный отказ человека — такого исхода в боте нет] → нехватка.
  // Поэтому перед репликой рассказ проходит ту же отдельную проверку, что и перед рендером: опасность даёт остановку,
  // незавершённая проверка — технический ответ, и только полное разрешение — реплику нехватки.
  // В метрики — только код события, без текста рассказа и номеров предложений.
  // Решение владельца 1 (PR 11): если исключался фрагмент уровня concern, сразу за репликой — тот же блок помощи,
  // что у прежней карточки concern (helpMessage('concern')), без переходной фразы, черновика и кнопок.
  // Признак concern — уровень всего рассказа, как у прежней карточки. Решение владельца 11.11 09:05: ОДНО сообщение
  // «реплика, пустая строка, блок помощи» — между двумя сообщениями блок помощи мог бы потеряться. Длина
  // (реплика + helpMessage('concern')) ограничена тестом (≤ 3500) и проверяется при отправке (insufficientMessages):
  // сверх 4096 — сначала блок помощи, затем реплика, код message_too_long в журнале; сейчас 256 знаков.
  // Решение владельца 11.11 12:05, п. 4: обычная нехватка у заготовки (insufficient_material) идёт тем же путём
  // и с той же репликой; в метрику — только код причины из закрытого списка.
  async function replyInsufficient(chatId, s, story, gen, current, concern, code = INSUFFICIENT_AFTER_EXCLUSION) {
    // Тот же рассказ сейчас в работе и ещё не остановлен: поздняя остановка (как в ветке !r.episode, at: 'late').
    // Без этого два подряд одинаковых рассказа, у первого из которых проверка вернула true, оставляли человека
    // без карточки помощи: первый ответ устарел, у второго current() уже false из-за safety — оба молча выходили.
    const sameStoryInWork = () => alive(chatId, s) && s.verdict !== 'blocked' && !!s.originalStory && storyKey(s.originalStory) === storyKey(story);
    const stoppedNow = () => isBlocked(s, story) || gate.status(s.scope, story).kind === 'safety';
    if (!current()) {
      if (stoppedNow() && sameStoryInWork()) return stopForSafety(chatId, s, 'urgent', { at: 'late' });
      return;
    }
    const g = await track(chatId, gate.verify(s.scope, story, null, story, { includeDrafts: true }));
    if (!alive(chatId, s)) return;
    if (g.kind === 'safety') {
      if (s.draftId === gen) return stopForSafety(chatId, s, 'urgent', { at: 'check', byModel: true });
      if (sameStoryInWork()) return stopForSafety(chatId, s, 'urgent', { at: 'late', byModel: true });
      return;
    }
    if (s.draftId !== gen) return;
    if (!g.ok) {
      logError('check', { code: g.code });
      s.stage = 'idle';
      return tg.send(chatId, g.kind === 'technical' ? TEXT.checkPaused : TEXT.checkUnavailable);
    }
    if (!current()) return;
    s.stage = 'idle'; // заготовка появится только перед самой отправкой реплики (восьмой разбор)
    await metrics.log(chatId, code === INSUFFICIENT_MATERIAL ? INSUFFICIENT_MATERIAL : INSUFFICIENT_AFTER_EXCLUSION);
    if (!current()) {
      // Пока писалась метрика, тот же рассказ остановлен (например, проверкой прежней сессии): карточка помощи, не тишина.
      if (stoppedNow() && sameStoryInWork()) return stopForSafety(chatId, s, 'urgent', { at: 'late' });
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
    const risk = assessEpisodeRisk(joinEdits(s.story), s.episode); // правки — продолжение рассказа для проверки безопасности
    if (risk.level === 'urgent') return stopForSafety(chatId, s, 'urgent', { at: 'render' });
    const v = validateSafeEpisode(s.episode, s.story);
    if (!v.ok) { await showDraft(chatId, s); return; }
    const gen = s.draftId;
    const original = s.originalStory || s.story;
    const current = () => alive(chatId, s) && s.draftId === gen && s.verdict === 'ok' && !isBlocked(s, original) && gate.status(s.scope, original).kind === null;
    // ИР-04 (критик реализации): один рендер идёт, до трёх ждут. Дальше — явный ответ «занято», без долговечной очереди.
    if (waiting >= 1 + MAX_RENDER_WAITING) return tg.send(chatId, TEXT.busy); // состояние сессии не меняется
    const ep = structuredClone(s.episode);
    const story = s.story;
    // Отдельная проверка именно этой версии (рассказ + строки + пост + название/жанр) перед очередью.
    s.stage = 'rendering';
    const g = await track(chatId, gate.verify(s.scope, original, ep, `${joinEdits(story)}\n${episodeToText(ep)}`));
    if (!alive(chatId, s) || s.draftId !== gen) return; // удалённая или заменённая сессия не оживает
    if (g.kind === 'safety') return stopForSafety(chatId, s, 'urgent', { at: 'check', byModel: true });
    if (!g.ok) {
      logError('check', { code: g.code });
      s.stage = 'draft';
      return tg.send(chatId, g.kind === 'technical' ? TEXT.checkPaused : TEXT.checkUnavailable);
    }
    if (!current()) { if (alive(chatId, s) && s.stage === 'rendering') s.stage = s.verdict === 'blocked' ? 'help' : 'draft'; return; }
    if (waiting >= 1 + MAX_RENDER_WAITING) { s.stage = 'draft'; return tg.send(chatId, TEXT.busy); }
    const ahead = waiting;
    waiting++;
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
        return render(ep, { story, outPath: out, preset: process.env.BOT_PRESET || 'standard', watermark: WATERMARK || false });
      });
      queue = job.catch(() => {});
      const r = await job;
      // После рендера: если черновик остановлен или сессия удалена, видео не отправляется (файл удалится ниже).
      if (r === STALE || !current()) return;
      await tg.sendVideo(chatId, r.outPath, { caption: 'Конец сцены.', width: 720, height: 1280, duration: Math.round(r.duration), reply_markup: FEEDBACK_KB });
      // /delete во время отправки: после metrics.forget новая запись о человеке не появляется.
      if (!alive(chatId, s)) return;
      await metrics.log(chatId, 'render', { seconds: Math.round(r.seconds), mood: ep.mood, music: ep.music, edits: s.edits || 0 });
      if (current()) s.stage = 'watched';
    } catch (e) {
      logError('render', e);
      if (current()) {
        s.stage = 'draft';
        await tg.send(chatId, TEXT.renderFail);
      }
    } finally {
      waiting--;
      await fs.rm(out, { force: true });
    }
  }

  async function onMessage(msg) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return; // только личные чаты: истории не для групп
    const s = session(chatId);
    const text = cleanInput(msg.text || '').trim(); // разделитель правок не может прийти от человека

    if (text === '/start') { s.stage = 'idle'; s.period = 'day'; await metrics.log(chatId, 'start'); return tg.send(chatId, TEXT.start); }
    if (text === '/year') { s.stage = 'idle'; s.period = 'year'; await metrics.log(chatId, 'year'); return tg.send(chatId, TEXT.year); }
    if (text === '/delete') {
      sessions.delete(chatId);
      // Честный ответ (редактор 16:24): «удалены» — только если удаление сессии и статистики подтверждено.
      // Запреты safety/technical по /delete не снимаются; если они есть, полное удаление не подтверждается.
      let forgot = true;
      try { await metrics.forget(chatId); } catch { forgot = false; }
      const kinds = gate.recordsFor(`chat:${chatId}`);
      const lines = [forgot ? TEXT.deleted : TEXT.deleteFailed];
      if (kinds === null) lines.push(TEXT.recordUnknown); // намеренное сохранение не утверждаем
      else {
        const fictional = process.env.TITRY_STAND === 'fictional';
        if (fictional && kinds.has('safety')) lines.push(TEXT.keptSafety);
        if (fictional && kinds.has('technical')) lines.push(TEXT.keptTechnical);
        // Не вымышленный стенд (срок не утверждён) или черновик/проверка ещё идут и могут поставить запрет.
        if ((kinds.size && !fictional) || inFlight.has(chatId)) lines.push(TEXT.deleteKept);
      }
      return tg.send(chatId, lines.join('\n'));
    }
    if (text === '/help') return tg.send(chatId, TEXT.editHelp, { parse_mode: 'HTML' });

    if (s.stage === 'rendering') return tg.send(chatId, TEXT.rendering);

    if (msg.voice) {
      if (!sttAvailable() && transcribe === transcribeOgg) return tg.send(chatId, TEXT.voiceOff);
      if (msg.voice.duration > MAX_VOICE_SECONDS) return tg.send(chatId, TEXT.voiceLong);
      await tg.action(chatId, 'typing');
      let story = '';
      try { story = cleanInput(await transcribe(await tg.fileBuffer(msg.voice.file_id), { duration: msg.voice.duration })); }
      catch (e) { logError('stt', e); }
      if (!alive(chatId, s)) return; // /delete во время распознавания: ничего не отвечаем
      if (!story) return tg.send(chatId, TEXT.voiceEmpty);
      await tg.send(chatId, `Расшифровка:\n«${story}»`);
      return handleStory(chatId, s, story, 'voice');
    }

    if (!text) return;
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
        const ctx = own ? `${s.story}${EDIT_SEP}${/[.!?…]$/.test(own) ? own : `${own}.`}` : s.story;
        let concern = false;
        if (own) {
          // Для проверок безопасности правки — продолжение рассказа (joinEdits, PR 13): «Я хочу» + правка «умереть».
          const prevLevel = assessRisk(joinEdits(s.story)).level;
          const risk = assessRisk(joinEdits(ctx));
          if (risk.level === 'urgent') { s.story = ctx; return stopForSafety(chatId, s, 'urgent', { at: 'edit' }); }
          // concern, который внесла сама правка: строка не берётся, рядом — тот же блок помощи, что у рассказа с concern
          // (одним сообщением, как в PR 11). Реплики нехватки здесь нет: прежний черновик остаётся.
          // Если рассказ уже был concern, блок помощи человек видел вместе с черновиком: правка, которая сама по себе
          // none, отклоняется ниже правилом титров без повторного блока (четвёртый разбор, мелочь 3).
          concern = risk.level === 'concern' && (prevLevel === 'none' || assessRisk(own).level !== 'none');
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
          const joined = joinEdits(ctx);
          if (!excluded && path && (threatErrors(joined, s.episode).some((e) => e.path === path)
            || (/^(?:rows\.|post$)/.test(path) && threatPronounFilter(joined)(own)))) excluded = true;
          if (excluded) s.episode = before;
          // Один вердикт на правку: та же проверка, что перед рендером (рассказ + поля эпизода). Если она даёт urgent,
          // остановка сейчас, а не обещание «черновик на месте» и остановка на «Смотреть».
          if (assessEpisodeRisk(joined, s.episode).level === 'urgent') return stopForSafety(chatId, s, 'urgent', { at: 'edit' });
          if (excluded) {
            await metrics.log(chatId, 'edit_excluded', { level: concern ? 'concern' : 'none' });
            for (const t of editExcludedMessages(concern, { path })) await tg.send(chatId, t);
            return;
          }
        }
        s.edits = (s.edits || 0) + 1;
        s.stage = 'draft';
        return showDraft(chatId, s);
      }
    }
    if (text.startsWith('/')) return tg.send(chatId, TEXT.start);
    if (text.length < 12) return tg.send(chatId, 'Расскажи чуть подробнее: что было, что запомнилось.');
    return handleStory(chatId, s, text, 'text');
  }

  async function onCallback(q) {
    const chatId = q.message && q.message.chat.id;
    await tg.answer(q.id);
    if (!chatId) return;
    const s = session(chatId);
    const data = q.data || '';
    if (data.startsWith('fb:')) {
      const v = data.slice(3);
      await metrics.log(chatId, 'feedback', { value: v });
      if (v === 'heavier') { await tg.send(chatId, TEXT.heavier); return tg.send(chatId, helpMessage('concern')); }
      return tg.send(chatId, v === 'fit' ? TEXT.fit : TEXT.miss);
    }
    if (data === 'edit') return tg.send(chatId, TEXT.editHelp, { parse_mode: 'HTML' });
    const [action, idPart] = data.split(':');
    if (s.stage === 'rendering') return tg.send(chatId, TEXT.rendering);
    // Кнопка работает только для текущего черновика, прошедшего проверку безопасности.
    const current = s.episode && s.verdict === 'ok' && (s.stage === 'draft' || s.stage === 'watched') && Number(idPart) === s.draftId;
    if (!current) return tg.send(chatId, s.stage === 'help' ? helpMessage('urgent') : TEXT.noDraft);
    if (action === 'play') return doRender(chatId, s);
    if (action === 'mood') { s.episode.mood = MOOD_ORDER[(MOOD_ORDER.indexOf(s.episode.mood) + 1) % MOOD_ORDER.length]; s.stage = 'draft'; return showDraft(chatId, s); }
    if (action === 'music') { s.episode.music = MUSIC_ORDER[(MUSIC_ORDER.indexOf(s.episode.music) + 1) % MUSIC_ORDER.length]; s.stage = 'draft'; return showDraft(chatId, s); }
  }

  async function handleUpdate(u) {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { logError('update', e); }
  }

  return { handleUpdate, sessions, sweep };
}

// ── Транспорт Telegram Bot API ───────────────────────────────────────────────

export function telegram(token) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body || {}),
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
    async fileBuffer(file_id) {
      const f = await call('getFile', { file_id });
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
      if (!res.ok) throw new Error(`Telegram file ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async sendVideo(chat_id, file, extra = {}) {
      const form = new FormData();
      form.append('chat_id', String(chat_id));
      form.append('supports_streaming', 'true');
      for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      form.append('video', new Blob([await fs.readFile(file)], { type: 'video/mp4' }), 'titry.mp4');
      return call('sendVideo', form);
    },
  };
}

/**
 * Подготовка до приёма задач (B09.6, решение владельца 17:10 и 18:05): очистка остатков голосовых и загрузка
 * хранилища запретов. Любая ошибка — исключение: вызывающий не начинает опрос Telegram (fail closed).
 * Нет ключа хранилища — тоже отказ запуска, а не тихий режим.
 */
<<<<<<< HEAD
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

export async function prepareBot({ cleanup = cleanupVoiceOrphans, cleanupTmp = purgeBotTmp, ledger, env = process.env, log = console.error } = {}) {
  if (!env.METRICS_SALT || String(env.METRICS_SALT).trim().length < METRICS_SALT_MIN) {
    logError('metrics.salt', { code: 'metrics_salt' });
    throw Object.assign(new Error('startup'), { code: 'metrics_salt', stage: 'metrics.salt' });
  }
=======
export async function prepareBot({ cleanup = cleanupVoiceOrphans, ledger, helpFile } = {}) {
  // Контакты помощи — до всего остального: без проверенного блока помощи бот не стартует (решение владельца 11:05).
  try { prepareHelp(helpFile); } catch (e) { logError('help.load', e); throw Object.assign(new Error('startup'), { code: 'help_config', stage: 'help.load' }); }
>>>>>>> origin/claude/edits-same-filter
  try { await cleanup(); } catch (e) { logError('voice.cleanup', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'voice.cleanup' }); }
  try {
    const removed = await cleanupTmp();
    // Только этап и число, без путей и имён; формат строки — как у журнала ошибок.
    if (removed) log(JSON.stringify({ at: new Date().toISOString(), level: 'info', stage: 'tmp.cleanup', removed }));
  } catch (e) { logError('tmp.cleanup', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'tmp.cleanup' }); }
  const l = ledger || makeLedger({ file: path.join(ROOT, 'data', 'state', 'blocked-v1.json'), key: process.env[KEY_ENV], keyVersion: process.env[KEY_VERSION_ENV] || 'v1' });
  try { await l.load(); } catch (e) { logError('ledger.load', e); throw Object.assign(new Error('startup'), { code: 'ledger', stage: 'ledger.load' }); }
  return l;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('Задайте TELEGRAM_BOT_TOKEN (выдаёт @BotFather).'); process.exit(2); }
  let ledger;
  try { ledger = await prepareBot(); } catch {
<<<<<<< HEAD
    console.error(`Запуск остановлен: не задана METRICS_SALT (не короче ${METRICS_SALT_MIN} знаков), не подтверждена очистка временных файлов или хранилище запретов (${KEY_ENV}, ${KEY_VERSION_ENV}). Задачи не принимаются. Остатки tmp и файл хранилища не удаляйте вручную без владельца кода.`);
=======
    console.error(`Запуск остановлен: не проверены контакты помощи (config/help.json), не подтверждена очистка временных файлов или хранилище запретов (${KEY_ENV}, ${KEY_VERSION_ENV}). Задачи не принимаются. Остатки tmp и файл хранилища не удаляйте вручную без владельца кода.`);
>>>>>>> origin/claude/edits-same-filter
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
  const bot = createBot({ tg, ledger });
  setInterval(bot.sweep, 10 * 60 * 1000).unref();
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        bot.handleUpdate(u); // не ждём: рендер одного пользователя не блокирует ответы другим
      }
    } catch (e) {
      logError('poll', e);
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
