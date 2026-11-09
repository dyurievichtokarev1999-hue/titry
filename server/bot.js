// Telegram-бот «Титры»: голосовое или текст → черновик титров → правка → MP4 9:16 в чат.
// Без внешних зависимостей для Telegram: Bot API через fetch, long polling.
// Запуск: TELEGRAM_BOT_TOKEN=... npm run bot
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, LIMITS, creditRows, dateLabel, todayIso, validateEpisode, PERIODS } from '../engine/episode.js';
import { makeDraft } from './draft.js';
import { helpMessage, assessEpisodeRisk } from './safety.js';
import { renderEpisode, ROOT } from './render.js';
import { transcribeOgg, sttAvailable, MAX_VOICE_SECONDS } from './stt.js';

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
    '/year — титры 2026 года\n/delete — удалить всё, что бот о тебе хранит',
  ].join('\n\n'),
  year: 'Расскажи про свой 2026 год за минуту: что случилось, кто был рядом, что осталось с тобой. Можно голосом.',
  working: 'Монтирую…',
  rendering: 'Собираю ролик. Обычно это меньше минуты.',
  queue: (n) => `Собираю ролик. Перед тобой в очереди: ${n}.`,
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
  deleted: 'Готово: сессия и статистика по тебе удалены.',
  renderFail: 'Не получилось собрать ролик. Попробуй ещё раз чуть позже.',
  draftFail: 'Не получилось собрать черновик. Попробуй ещё раз чуть позже.',
};

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

export function makeMetrics(file = path.join(ROOT, 'data', 'metrics.jsonl'), salt = process.env.METRICS_SALT || 'titry-dev-salt') {
  const hash = (id) => crypto.createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 16);
  return {
    hash,
    async log(chatId, event, extra = {}) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), user: hash(chatId), event, ...extra }) + '\n');
    },
    async forget(chatId) {
      const h = hash(chatId);
      let text = '';
      try { text = await fs.readFile(file, 'utf8'); } catch { return; }
      const kept = text.split('\n').filter((l) => l && !l.includes(`"user":"${h}"`));
      await fs.writeFile(file, kept.length ? kept.join('\n') + '\n' : '');
    },
  };
}

// ── Логика бота (транспорт подменяется в тестах) ─────────────────────────────

export function createBot({ tg, metrics = makeMetrics(), draft = makeDraft, render = renderEpisode, transcribe = transcribeOgg, now = () => new Date() } = {}) {
  const sessions = new Map();
  // Ключ рассказа: запрет по безопасности привязан к самому рассказу, а не к интерфейсу.
  const storyKey = (story) => crypto.createHash('sha256').update(String(story).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()).digest('hex');
  let queue = Promise.resolve();
  let waiting = 0;

  const session = (chatId) => {
    let s = sessions.get(chatId);
    if (!s) { s = { stage: 'idle', period: 'day' }; sessions.set(chatId, s); }
    s.touched = Date.now();
    return s;
  };

  function sweep() {
    const limit = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) if (s.touched < limit) sessions.delete(id);
  }

  async function showDraft(chatId, s) {
    s.validation = validateEpisode(s.episode, s.story);
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
    if (isBlocked(s, story)) {
      return stopForSafety(chatId, s, 'urgent', { at: 'repeat' });
    }
    const current = () => alive(chatId, s) && s.draftId === gen && !isBlocked(s, story);
    await tg.action(chatId, 'typing');
    await tg.send(chatId, TEXT.working);
    let r;
    try {
      r = await draft(story, { date: todayIso(now()), period: s.period, tone: 'quiet' });
    } catch (e) {
      console.error('draft', e);
      if (!current()) return;
      s.stage = 'idle';
      await tg.send(chatId, TEXT.draftFail);
      return;
    }
    if (!alive(chatId, s)) return; // удалённая сессия не оживает из отложенного ответа
    if (!r.episode) {
      // Остановка важнее всего, даже если ответ устарел: рассказ запоминается как запрещённый.
      if (s.draftId === gen) return stopForSafety(chatId, s, r.risk.level, { byModel: r.risk.byModel });
      s.blocked = s.blocked || new Set();
      s.blocked.add(storyKey(story));
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

  async function doRender(chatId, s) {
    // Правки после черновика тоже проверяются: опасная строка не попадёт в ролик.
    if (s.verdict !== 'ok' || !s.episode) return tg.send(chatId, TEXT.noDraft);
    const risk = assessEpisodeRisk(s.story, s.episode);
    if (risk.level === 'urgent') return stopForSafety(chatId, s, 'urgent', { at: 'render' });
    const v = validateEpisode(s.episode, s.story);
    if (!v.ok) { await showDraft(chatId, s); return; }
    const gen = s.draftId;
    const original = s.originalStory || s.story;
    const current = () => alive(chatId, s) && s.draftId === gen && s.verdict === 'ok' && !isBlocked(s, original);
    s.stage = 'rendering';
    const ahead = waiting;
    waiting++;
    const ep = structuredClone(s.episode);
    const story = s.story;
    const out = path.join(ROOT, 'data', 'tmp', `${metrics.hash(chatId)}-${Date.now()}.mp4`);
    const STALE = Symbol('stale');
    let job;
    try {
      await tg.send(chatId, ahead ? TEXT.queue(ahead) : TEXT.rendering);
      job = queue.then(async () => {
        // Перед стартом из очереди: черновик мог быть остановлен или удалён, пока задача ждала.
        if (!current()) return STALE;
        await tg.action(chatId, 'upload_video');
        return render(ep, { story, outPath: out, preset: process.env.BOT_PRESET || 'standard', watermark: WATERMARK || false });
      });
      queue = job.catch(() => {});
      const r = await job;
      // После рендера: если черновик остановлен или сессия удалена, видео не отправляется (файл удалится ниже).
      if (r === STALE || !current()) return;
      await tg.sendVideo(chatId, r.outPath, { caption: 'Конец сцены.', width: 720, height: 1280, duration: Math.round(r.duration), reply_markup: FEEDBACK_KB });
      await metrics.log(chatId, 'render', { seconds: Math.round(r.seconds), mood: ep.mood, music: ep.music, edits: s.edits || 0 });
      if (current()) s.stage = 'watched';
    } catch (e) {
      console.error('render', e);
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
    if (text === '/delete') { sessions.delete(chatId); await metrics.forget(chatId); return tg.send(chatId, TEXT.deleted); }
    if (text === '/help') return tg.send(chatId, TEXT.editHelp, { parse_mode: 'HTML' });

    if (s.stage === 'rendering') return tg.send(chatId, TEXT.rendering);

    if (msg.voice) {
      if (!sttAvailable() && transcribe === transcribeOgg) return tg.send(chatId, TEXT.voiceOff);
      if (msg.voice.duration > MAX_VOICE_SECONDS) return tg.send(chatId, TEXT.voiceLong);
      await tg.action(chatId, 'typing');
      let story = '';
      try { story = await transcribe(await tg.fileBuffer(msg.voice.file_id), { duration: msg.voice.duration }); }
      catch (e) { console.error('stt', e); }
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
    } catch (e) { console.error('update', e); }
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
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
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

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('Задайте TELEGRAM_BOT_TOKEN (выдаёт @BotFather).'); process.exit(2); }
  const tg = telegram(token);
  const me = await tg.call('getMe');
  await tg.call('setMyCommands', { commands: [
    { command: 'start', description: 'Как это работает' },
    { command: 'year', description: 'Титры 2026 года' },
    { command: 'help', description: 'Как поправить строку' },
    { command: 'delete', description: 'Удалить всё о себе' },
  ] }).catch(() => {});
  console.log(`Бот @${me.username} запущен. Распознавание речи: ${sttAvailable() ? 'SpeechKit' : 'выключено'}.`);
  const bot = createBot({ tg });
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
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
