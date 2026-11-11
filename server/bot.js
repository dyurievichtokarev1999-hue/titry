// Telegram-бот «Титры»: голосовое или текст → черновик титров → правка → MP4 9:16 в чат.
// Без внешних зависимостей для Telegram: Bot API через fetch, long polling.
// Запуск: TELEGRAM_BOT_TOKEN=... npm run bot
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, LIMITS, creditRows, dateLabel, todayIso, validateEpisode, PERIODS, episodeToText } from '../engine/episode.js';
import { makeDraft, modelSafetyCheck, hasClaudeCredentials } from './draft.js';
import { makeGate } from './gate.js';
import { helpMessage, loadHelp, assessEpisodeRisk, validateSafeEpisode } from './safety.js';
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
  editHelp: [
    'Как поправить:',
    '<code>2: вечерний звонок</code> — новый текст строки 2',
    '<code>2: Друг — вечерний звонок</code> — роль и текст',
    '<code>-3</code> — убрать строку 3',
    '<code>+ Окно — долгий вечер</code> — добавить строку',
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
  insufficient: 'Не получилось собрать титры только из твоих слов. Сегодня можно без ролика.',
};

/** Ответ при нехватке материала: реплика; при concern — одним сообщением с блоком помощи сразу после пустой строки. */
export function insufficientMessage(concern, help = loadHelp()) {
  return concern ? `${TEXT.insufficient}\n\n${helpMessage('concern', help)}` : TEXT.insufficient;
}
export const TELEGRAM_TEXT_LIMIT = 4096;

// ── Чистые функции: разбор правок ────────────────────────────────────────────

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
      rows.push({ role: cmd.role.slice(0, LIMITS.role), value: cmd.value.slice(0, LIMITS.value), source: cmd.value.slice(0, LIMITS.value) }); return null;
    case 'row':
      if (idx < 0 || idx >= rows.length) return `Строки ${cmd.n} нет.`;
      if (cmd.role) rows[idx].role = cmd.role.slice(0, LIMITS.role);
      rows[idx].value = cmd.value.slice(0, LIMITS.value);
      rows[idx].source = rows[idx].value; // слова самого человека; бот добавляет правку в опору (editCorpus)
      return null;
    case 'title': if (!cmd.value) return 'Название не может быть пустым.'; ep.title = cmd.value.slice(0, LIMITS.title); return null;
    case 'genre': if (!cmd.value) return 'Жанр не может быть пустым.'; ep.genre = cmd.value.slice(0, LIMITS.genre); return null;
    case 'lead': ep.lead = (cmd.value || 'ты').slice(0, 24); return null;
    case 'post':
      ep.post = cmd.value === '-' || !cmd.value ? { text: '', source: '' } : { text: cmd.value.slice(0, LIMITS.post), source: cmd.value.slice(0, LIMITS.post) };
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
  if (problems.length) lines.push('', ...problems.map((e) => `⚠ ${esc(e.msg)}`));
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

export function makeMetrics(file = path.join(ROOT, 'data', 'metrics.jsonl'), salt = process.env.METRICS_SALT || 'titry-dev-salt', { forgetTimeoutMs = 10000 } = {}) {
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
    if (r.insufficient) return replyInsufficient(chatId, s, story, gen, current, r.risk && r.risk.level === 'concern');
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
    if (!current()) return; // устаревший «можно» молча отбрасывается
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
  // (реплика + helpMessage('concern')) меньше лимита Telegram 4096; проверяется тестом, молча не делится.
  async function replyInsufficient(chatId, s, story, gen, current, concern) {
    if (!current()) return;
    const g = await track(chatId, gate.verify(s.scope, story, null, story));
    if (!alive(chatId, s) || s.draftId !== gen) return;
    if (g.kind === 'safety') return stopForSafety(chatId, s, 'urgent', { at: 'check', byModel: true });
    if (!g.ok) {
      logError('check', { code: g.code });
      s.stage = 'idle';
      return tg.send(chatId, g.kind === 'technical' ? TEXT.checkPaused : TEXT.checkUnavailable);
    }
    if (!current()) return;
    s.stage = 'idle'; // черновика нет: правки и кнопки не к чему применять
    await metrics.log(chatId, 'insufficient_after_exclusion');
    if (!current()) return;
    return tg.send(chatId, insufficientMessage(concern));
  }

  async function doRender(chatId, s) {
    // Правки после черновика тоже проверяются: опасная строка не попадёт в ролик.
    if (s.verdict !== 'ok' || !s.episode) return tg.send(chatId, TEXT.noDraft);
    const risk = assessEpisodeRisk(s.story, s.episode);
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
    const g = await track(chatId, gate.verify(s.scope, original, ep, `${story}\n${episodeToText(ep)}`));
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
    const out = path.join(ROOT, 'data', 'tmp', `${metrics.hash(chatId)}-${Date.now()}.mp4`);
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
    const text = (msg.text || '').trim();

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
      try { story = await transcribe(await tg.fileBuffer(msg.voice.file_id), { duration: msg.voice.duration }); }
      catch (e) { logError('stt', e); }
      if (!alive(chatId, s)) return; // /delete во время распознавания: ничего не отвечаем
      if (!story) return tg.send(chatId, TEXT.voiceEmpty);
      await tg.send(chatId, `Расшифровка:\n«${story}»`);
      return handleStory(chatId, s, story, 'voice');
    }

    if (!text) return;
    if ((s.stage === 'draft' || s.stage === 'watched') && s.episode) {
      const cmd = parseEdit(text);
      if (cmd) {
        const err = applyEdit(s.episode, cmd);
        if (err) return tg.send(chatId, err);
        const own = editCorpus(cmd);
        if (own) s.story = `${s.story}\n${own}`; // опора хранится только в памяти сессии
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
export async function prepareBot({ cleanup = cleanupVoiceOrphans, ledger } = {}) {
  try { await cleanup(); } catch (e) { logError('voice.cleanup', e); throw Object.assign(new Error('startup'), { code: safeCode(e), stage: 'voice.cleanup' }); }
  const l = ledger || makeLedger({ file: path.join(ROOT, 'data', 'state', 'blocked-v1.json'), key: process.env[KEY_ENV], keyVersion: process.env[KEY_VERSION_ENV] || 'v1' });
  try { await l.load(); } catch (e) { logError('ledger.load', e); throw Object.assign(new Error('startup'), { code: 'ledger', stage: 'ledger.load' }); }
  return l;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('Задайте TELEGRAM_BOT_TOKEN (выдаёт @BotFather).'); process.exit(2); }
  let ledger;
  try { ledger = await prepareBot(); } catch {
    console.error(`Запуск остановлен: не подтверждена очистка временных файлов или хранилище запретов (${KEY_ENV}, ${KEY_VERSION_ENV}). Задачи не принимаются. Остатки tmp и файл хранилища не удаляйте вручную без владельца кода.`);
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
