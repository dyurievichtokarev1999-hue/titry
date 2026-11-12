// Монтажная: локальный сервер для консьерж-теста.
// Рассказ → черновик → правка строк → предпросмотр → MP4 для участника.
// Слушает только 127.0.0.1. Запуск: npm run studio
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, sanitizeEpisode, validateEpisode, episodeToText, cleanInput } from '../engine/episode.js';
import { makeDraft, hasClaudeCredentials, DEFAULT_MODEL, modelSafetyCheck } from './draft.js';
import { renderEpisode, ROOT } from './render.js';
import { logError, safeCode } from './errlog.js';
import { loadHelp, helpMessage, assessEpisodeRisk, validateSafeEpisode } from './safety.js';
import { makeGate } from './gate.js';
import { makeLedger, KEY_ENV, KEY_VERSION_ENV } from './ledger.js';

const STATIC = {
  '/': 'studio/index.html',
  '/studio.js': 'studio/studio.js',
  '/studio.css': 'studio/studio.css',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};
const SECURITY = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'",
};

// Что можно записать в журнал: только события, категории и числа. Никаких текстов рассказа и строк.
const REACTIONS = ['fit', 'miss', 'heavier', 'none'];
const REQUESTS = ['words', 'genre', 'film', 'music'];
const PROVIDERS = ['claude', 'manual', 'example'];

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { ...SECURITY, 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

/** Предел длины рассказа — как в makeDraft (server/draft.js). */
const STORY_MAX = 6000;
const TOO_LONG = 'Рассказ слишком длинный для одного эпизода.';

async function readJson(req, limit = 200_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413, expose: true }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Некорректный JSON.'), { status: 400, expose: true }); }
}

function safeName(s, fallback) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return v || fallback;
}

const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

export const OUT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Удалить ролики и постеры старше maxAgeMs (0 — все). Ролик удаляется после отправки кнопкой
 * в монтажной; это страховка для забытых, неотправленных и недособранных файлов.
 */
export async function purgeOut(dir, maxAgeMs = OUT_MAX_AGE_MS, now = Date.now(), { strict = false } = {}) {
  // strict (стартовая очистка, B09.6): любая ошибка, кроме «каталога/файла нет», — исключение;
  // вызывающий не начинает приём задач. Иначе — тихая фоновая страховка.
  const gone = (e) => e?.code === 'ENOENT';
  let removed = 0;
  let names = [];
  try {
    // Сам каталог должен быть настоящим каталогом, не ссылкой: иначе очистка ушла бы в чужой каталог.
    const d = await fs.lstat(dir);
    if (!d.isDirectory()) throw Object.assign(new Error('data/out — не каталог'), { code: d.isSymbolicLink() ? 'EACCES' : 'ENOTDIR' });
    names = await fs.readdir(dir);
  } catch (e) { if (strict && !gone(e)) throw e; return 0; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.lstat(file);
      // Ссылка удаляется как ссылка (цель не трогается): монтажная сама ссылок не создаёт и не отдаёт.
      if ((st.isFile() || st.isSymbolicLink()) && now - st.mtimeMs >= maxAgeMs) { await fs.rm(file, { force: true }); removed++; }
    } catch (e) { if (strict && !gone(e)) throw e; /* иначе: файл уже удалён */ }
  }
  return removed;
}

/** Строгая календарная дата ГГГГ-ММ-ДД, иначе null. */
export function strictDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

const bool = (v) => v === true;

/** Запись журнала: только разрешённые поля, без текстов. */
export function logRecord(body) {
  const ep = sanitizeEpisode(body.episode);
  const date = strictDate(body.episode && body.episode.date);
  if (!date) throw Object.assign(new Error('Некорректная дата эпизода: нужен формат ГГГГ-ММ-ДД.'), { status: 400, expose: true });
  const fb = body.feedback && typeof body.feedback === 'object' ? body.feedback : {};
  const edits = fb.edits && typeof fb.edits === 'object' ? fb.edits : {};
  return {
    savedAt: new Date().toISOString(),
    participant: safeName(body.participant, ''),
    day: int(Number(body.day), 1, 30),
    date,
    provider: PROVIDERS.includes(body.provider) ? body.provider : null,
    mood: MOODS[ep.mood] ? ep.mood : null,
    music: TRACKS[ep.music] ? ep.music : null,
    rows: ep.rows.filter((r) => r.role || r.value).length,
    hasPost: Boolean(ep.post.text),
    reaction: REACTIONS.includes(fb.reaction) ? fb.reaction : null,
    shared: bool(fb.shared),
    changedRows: int(edits.changedRows, 0, 20),
    titleChanged: bool(edits.titleChanged),
    genreChanged: bool(edits.genreChanged),
    moodChanged: bool(edits.moodChanged),
    requested: Array.isArray(fb.requested) ? fb.requested.filter((x) => REQUESTS.includes(x)) : [],
  };
}

/**
 * Создать сервер монтажной. Параметры нужны для тестов:
 * render — функция рендера (по умолчанию настоящий renderEpisode), dataDir — папка данных.
 */
// Тексты экрана организатора — редактор повествования 14:42, приняты владельцем 15:08, дословно
// (next для 503 — прежняя подсказка организатору PM-01, 9.11).
const UNAVAILABLE = {
  unavailable: true,
  error: 'Проверку завершить не удалось',
  message: 'Сервис не смог завершить проверку рассказа. Сейчас ролик не создаётся.',
  next: 'Повторить можно позже, только с полной проверкой заново. На заготовку без ИИ не переключаться. Если для рассказа ранее подтверждена остановка, повтор не снимает её.',
};
// Техническая приостановка (второй подряд неполный ответ): без слов об опасности, помощи и сроках.
const TECHNICAL = {
  kind: 'technical',
  reason: 'check_incomplete_twice',
  error: 'Проверка приостановлена',
  message: 'Сервис дважды не смог завершить проверку рассказа. Сейчас ролик не создаётся. Ждать в чате и отвечать на это сообщение не нужно.',
  next: 'Повторную полную проверку можно запустить только явным действием организатора, не раньше чем через 15 минут после второго сбоя. Ожидание и перезапуск сами по себе не снимают приостановку. Если остановка по безопасности уже подтверждена, она сохраняется.',
};
const SCOPE = 'studio'; // монтажная — одна общая область запретов

/**
 * Создать сервер монтажной. Параметры нужны для тестов:
 * render — функция рендера (по умолчанию настоящий renderEpisode), dataDir — папка данных,
 * safetyCheck — отдельная проверка (true — опасно, false — разрешение, исключение — проверка не завершена),
 * hasKey — есть ли доступ к модели, monoNow/wallNow — часы.
 */
export function createApp({
  render = renderEpisode,
  dataDir = path.join(ROOT, 'data'),
  safetyCheck,
  hasKey = safetyCheck ? () => true : hasClaudeCredentials,
  draft = makeDraft,
  monoNow, wallNow,
  ledger = null, // хранилище запретов; загружается до приёма задач (см. запуск ниже)
  gate = makeGate({ check: safetyCheck || ((text) => modelSafetyCheck(text)), hasKey, monoNow, wallNow, ledger }),
} = {}) {
  const OUT = path.join(dataDir, 'out');
  const LOG = path.join(dataDir, 'concierge');
  let rendering = Promise.resolve();
  // Ролики не переживают перезапуск монтажной и не лежат дольше 2 часов.
  purgeOut(OUT, 0).catch(() => {});
  const sweeper = setInterval(() => purgeOut(OUT).catch(() => {}), 10 * 60 * 1000);
  sweeper.unref();

  // S01–S04: подтверждённая опасность — 422, маршрут помощи. Только реально сработавший слой даёт byModel.
  const safetyStop = (risk = { level: 'urgent', byModel: true, matches: [] }, error = 'Ролик не собирается: сработал фильтр безопасности.') =>
    ({ status: 422, body: { error, kind: 'safety', risk, help: helpMessage('urgent') } });
  // Технические состояния: без помощи, без urgent/byModel.
  const technical = (r) => ({ status: 422, body: { ...TECHNICAL, code: 'check_incomplete_twice', retryNotBeforeAt: r.retryNotBeforeAt || null } });
  const unavailable = (code) => ({ status: 503, body: { ...UNAVAILABLE, code } });
  // В журнал — только этап и код (ИР-03), без текста и сообщений исключений.
  const fromGate = (r, stage = 'check') => {
    if (r.kind === 'unavailable') r = { unavailable: true, code: r.code };
    if (r.kind !== 'safety') logError(stage, { code: r.kind === 'technical' ? 'check_incomplete_twice' : r.code });
    return r.kind === 'safety' ? safetyStop() : r.kind === 'technical' ? technical(r) : unavailable(r.code);
  };

  const routes = {
    'GET /api/config': async () => ({
      provider: hasClaudeCredentials() ? 'claude' : 'manual',
      model: hasClaudeCredentials() ? DEFAULT_MODEL : null,
      help: loadHelp(),
    }),

    'POST /api/draft': async (req) => {
      const body = await readJson(req);
      const story = typeof body.story === 'string' ? cleanInput(body.story) : body.story; // разделитель правок не приходит снаружи
      const draftStop = (risk) => safetyStop(risk, 'Черновик остановлен: сработал фильтр безопасности.');
      const before = gate.status(SCOPE, story);
      if (before.kind === 'safety') return draftStop({ level: 'urgent', byModel: true, matches: [] });
      if (before.kind === 'technical') return technical(before);
      if (before.kind === 'unavailable') return fromGate(before, 'draft');
      const result = await draft(story, {
        date: body.date, period: body.period, tone: body.tone, provider: body.provider,
      });
      if (result.unavailable) return unavailable(result.code);
      if (!result.episode) {
        // S01 (локальный слой) и S03 (генератор): рассказ остановлен в этой области.
        if (result.risk.level === 'urgent') { gate.markSafety(SCOPE, story); return draftStop(result.risk); }
        return { risk: result.risk, help: helpMessage(result.risk.level) };
      }
      // Остановка, пришедшая из параллельного запроса, пока модель писала черновик, важнее черновика.
      const after = gate.status(SCOPE, story);
      if (after.kind === 'safety') return draftStop({ level: 'urgent', byModel: true, matches: [] });
      if (after.kind === 'technical') return technical(after);
      if (after.kind === 'unavailable') return fromGate(after, 'draft');
      return {
        episode: result.episode, validation: result.validation, risk: result.risk,
        provider: result.provider, note: result.note, dropped: result.dropped,
        help: result.risk.level === 'concern' ? helpMessage('concern') : null,
      };
    },

    // Явное действие организатора после технической приостановки: полная отдельная проверка заново.
    // Монтажная слушает только 127.0.0.1 и принимает POST только со своего источника — это экран организатора.
    'POST /api/recheck': async (req) => {
      const body = await readJson(req);
      const ep = sanitizeEpisode(body.episode);
      const story = cleanInput(body.story || '');
      const r = await gate.organizerRetry(SCOPE, story, ep, `${story}\n${episodeToText(ep)}`);
      if (r.ok) return { rechecked: true };
      if (r.notPaused) return { status: 409, body: { error: 'Для этого рассказа нет технической приостановки.' } };
      if (r.early) return { status: 422, body: { ...TECHNICAL, code: 'check_incomplete_twice', early: true, retryNotBeforeAt: r.retryNotBeforeAt } };
      if (r.inProgress) return { status: 409, body: { error: 'Повторная проверка уже идёт.' } };
      return fromGate(r, 'recheck');
    },

    'POST /api/validate': async (req) => {
      const body = await readJson(req);
      const ep = sanitizeEpisode(body.episode);
      // длина рассказа ограничивается до проверки (тот же предел, что у черновика)
      if (cleanInput(body.story || '').length > STORY_MAX) return { status: 413, body: { error: TOO_LONG } };
      return { episode: ep, validation: validateSafeEpisode(ep, cleanInput(body.story || '')), text: episodeToText(ep) };
    },

    'POST /api/render': async (req) => {
      const body = await readJson(req);
      const ep = sanitizeEpisode(body.episode);
      const story = cleanInput(body.story || '');
      const risk = assessEpisodeRisk(story, ep);
      if (risk.level === 'urgent') { gate.markSafety(SCOPE, story); return safetyStop(risk); }
      // длина — после остановки по безопасности (длинный опасный рассказ всё равно останавливается), до проверки строк
      if (story.length > STORY_MAX) return { status: 413, body: { error: TOO_LONG } };
      const v = validateSafeEpisode(ep, story);
      if (!v.ok) return { status: 422, body: { error: 'Исправьте ошибки перед рендером.', validation: v } };
      // Инвариант: после остановки по рассказу ни один запрос с ним не запускает рендер и не отдаёт ролик.
      // Ответ «можно» никогда не снимает остановку — ни повторный, ни пришедший позже из параллельного запроса.
      // Разрешение действует только для проверенной сейчас версии (рассказ + строки + пост + название/жанр).
      const g = await gate.verify(SCOPE, story, ep, `${story}\n${episodeToText(ep)}`);
      if (!g.ok) return fromGate(g);
      const stopped = () => gate.status(SCOPE, story).kind !== null;
      const modelStop = () => fromGate(gate.status(SCOPE, story));
      const id = `${ep.date}-${safeName(body.participant, 'p')}-${crypto.randomBytes(3).toString('hex')}`;
      const files = [path.join(OUT, `${id}.mp4`), path.join(OUT, `${id}.jpg`)];
      const STOPPED = Symbol('stopped');
      const job = rendering.then(() => {
        // Проверка при запуске из очереди: остановка могла прийти, пока задача ждала.
        if (stopped()) return STOPPED;
        return render(ep, {
          story,
          outPath: files[0], posterPath: files[1],
          preset: ['preview', 'standard', 'hd'].includes(body.preset) ? body.preset : 'standard',
          still: !!body.still, watermark: body.watermark ? 'сделано в титрах' : false,
        });
      });
      rendering = job.catch(() => {});
      const r = await job;
      if (r === STOPPED) return modelStop();
      // Остановка во время рендера: готовый файл удаляется и никому не отдаётся.
      if (stopped()) {
        await Promise.all(files.map((f) => fs.rm(f, { force: true })));
        return modelStop();
      }
      return { video: `/out/${id}.mp4`, poster: `/out/${id}.jpg`, seconds: r.seconds, validation: v };
    },

    // Ролик отправлен участнику — удалить рабочие копии (видео и постер).
    'POST /api/out/delete': async (req) => {
      const body = await readJson(req);
      const m = /^\/out\/([0-9a-z-]+)\.mp4$/.exec(String(body.video || ''));
      if (!m) return { status: 400, body: { error: 'Некорректный путь к ролику.' } };
      for (const ext of ['.mp4', '.jpg']) await fs.rm(path.join(OUT, m[1] + ext), { force: true });
      return { deleted: true };
    },

    // Журнал консьерж-теста: только события и числа (см. logRecord). Хранится локально в data/concierge.
    'POST /api/log': async (req) => {
      const body = await readJson(req);
      if (!body.consent) return { status: 400, body: { error: 'Нет отметки о согласии участника.' } };
      const record = logRecord(body);
      if (!record.participant) return { status: 400, body: { error: 'Укажите код участника латиницей, например p07.' } };
      const dir = path.resolve(LOG, record.participant);
      // Имя файла — только служебное; путь обязан остаться внутри каталога журнала.
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
      if (!dir.startsWith(path.resolve(LOG) + path.sep)) return { status: 400, body: { error: 'Некорректный код участника.' } };
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(record, null, 2));
      return { saved: path.relative(dataDir, file) };
    },
  };

  async function serveStatic(req, res, pathname) {
    let file = null;
    if (STATIC[pathname]) file = path.resolve(ROOT, STATIC[pathname]);
    else if (pathname.startsWith('/engine/') || pathname.startsWith('/brand/') || pathname.startsWith('/examples/')) file = path.resolve(ROOT, pathname.slice(1));
    else if (pathname.startsWith('/audio/')) file = path.resolve(ROOT, 'assets/audio', pathname.slice(7));
    else if (pathname.startsWith('/out/')) file = path.resolve(OUT, pathname.slice(5));
    if (!file) return send(res, 404, { error: 'Не найдено.' });
    const ext = path.extname(file);
    const inside = file.startsWith(ROOT + path.sep) || file.startsWith(path.resolve(OUT) + path.sep);
    if (!inside || !MIME[ext] || file.includes(`${path.sep}.`)) return send(res, 404, { error: 'Не найдено.' });
    try {
      const data = await fs.readFile(file);
      const range = req.headers.range;
      if (range && (ext === '.mp4' || ext === '.wav')) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
        if (!m || start > end) return send(res, 416, { error: 'range' });
        res.writeHead(206, { ...SECURITY, 'Content-Type': MIME[ext], 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        return res.end(data.subarray(start, end + 1));
      }
      res.writeHead(200, { ...SECURITY, 'Content-Type': MIME[ext], 'Content-Length': data.length, 'Accept-Ranges': 'bytes' });
      res.end(data);
    } catch { send(res, 404, { error: 'Не найдено.' }); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    try {
      if (routes[key]) {
        if (req.method === 'POST') {
          const port = server.address().port;
          const origin = req.headers.origin;
          if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: 'Чужой источник запроса.' });
        }
        const out = await routes[key](req);
        if (out && out.status) return send(res, out.status, out.body);
        return send(res, 200, out);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
      send(res, 405, { error: 'Метод не поддерживается.' });
    } catch (e) {
      logError(routes[key] ? `http ${key}` : 'http', e);
      // Клиенту — только свои фиксированные тексты (expose) и текст остановки. Сообщения других исключений
      // (fs, ffmpeg, внешние API) могут содержать пути или фрагменты рассказа: вместо них — общий текст с кодом.
      if (e.expose || e.code === 'safety') return send(res, e.code === 'safety' ? 422 : e.status, { error: e.message, validation: e.validation });
      send(res, 500, { error: `Ошибка сервера (${safeCode(e)}). Попробуйте ещё раз.`, validation: e.validation });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  // Хранилище запретов: data/state/blocked-v1.json; пустой набор запретов не подставляется никогда.
  // Если хранилище сломается уже во время работы — ролики не выдаются (503 ledger).
  const ledger = makeLedger({ file: path.join(ROOT, 'data', 'state', 'blocked-v1.json'), key: process.env[KEY_ENV], keyVersion: process.env[KEY_VERSION_ENV] || 'v1' });
  // Отказ запуска, а не тихий режим (решение владельца 17:10): без ключа или при неисправном файле монтажная
  // не начинает принимать задачи.
  try { await ledger.load(); } catch (e) {
    logError('ledger.load', e);
    console.error(`Запуск остановлен: хранилище запретов недоступно. Проверьте ${KEY_ENV} (не короче 16 символов) и ${KEY_VERSION_ENV}.`);
    console.error('Остатки blocked-v1.json.tmp-* или повреждённый файл не удаляйте: это может снять подтверждённые остановки. Сохраните копию каталога data/state и обратитесь к владельцу кода.');
    process.exit(3);
  }
  // Стартовая очистка роликов и постеров прежнего запуска — до приёма задач (B09.6, решение владельца 18:05/20:05).
  // Ошибка — отказ запуска с кодом 3; в журнал только этап и код, без путей.
  try { await purgeOut(path.join(ROOT, 'data', 'out'), 0, Date.now(), { strict: true }); } catch (e) {
    logError('out.cleanup', e);
    console.error('Запуск остановлен: не подтверждена очистка роликов прежнего запуска (data/out). Задачи не принимаются.');
    process.exit(3);
  }
  createApp({ ledger }).listen(port, '127.0.0.1', () => {
    console.log(`Монтажная: http://127.0.0.1:${port}/`);
    console.log(hasClaudeCredentials() ? `Черновики: Claude (${DEFAULT_MODEL})` : 'Черновики: заготовка без ИИ (ключ ANTHROPIC_API_KEY не задан)');
  });
}
