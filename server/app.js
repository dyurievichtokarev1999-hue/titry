// Монтажная: локальный сервер для консьерж-теста.
// Рассказ → черновик → правка строк → предпросмотр → MP4 для участника.
// Слушает только 127.0.0.1. Запуск: npm run studio
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, sanitizeEpisode, validateEpisode, episodeToText } from '../engine/episode.js';
import { makeDraft, hasClaudeCredentials, DEFAULT_MODEL, modelSafetyCheck } from './draft.js';
import { renderEpisode, ROOT } from './render.js';
import { loadHelp, helpMessage, assessEpisodeRisk } from './safety.js';

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

async function readJson(req, limit = 200_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Некорректный JSON.'), { status: 400 }); }
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
export async function purgeOut(dir, maxAgeMs = OUT_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = await fs.readdir(dir); } catch { return 0; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (st.isFile() && now - st.mtimeMs >= maxAgeMs) { await fs.rm(file, { force: true }); removed++; }
    } catch { /* файл уже удалён */ }
  }
  return removed;
}

/** Строгая календарная дата ГГГГ-ММ-ДД, иначе null. */
export function strictDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

const storyKey = (story) => crypto.createHash('sha256').update(String(story).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()).digest('hex');
const bool = (v) => v === true;

/** Запись журнала: только разрешённые поля, без текстов. */
export function logRecord(body) {
  const ep = sanitizeEpisode(body.episode);
  const date = strictDate(body.episode && body.episode.date);
  if (!date) throw Object.assign(new Error('Некорректная дата эпизода: нужен формат ГГГГ-ММ-ДД.'), { status: 400 });
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
export function createApp({
  render = renderEpisode,
  dataDir = path.join(ROOT, 'data'),
  // Второй слой безопасности для прямого пути рендера: true — опасно, false — нет, null — модель недоступна.
  safetyCheck = async (story) => (hasClaudeCredentials() ? modelSafetyCheck(story) : null),
} = {}) {
  const OUT = path.join(dataDir, 'out');
  const LOG = path.join(dataDir, 'concierge');
  const blocked = new Set(); // рассказы, остановленные моделью в этой сессии монтажной
  let rendering = Promise.resolve();
  // Ролики не переживают перезапуск монтажной и не лежат дольше 2 часов.
  purgeOut(OUT, 0).catch(() => {});
  const sweeper = setInterval(() => purgeOut(OUT).catch(() => {}), 10 * 60 * 1000);
  sweeper.unref();

  const routes = {
    'GET /api/config': async () => ({
      provider: hasClaudeCredentials() ? 'claude' : 'manual',
      model: hasClaudeCredentials() ? DEFAULT_MODEL : null,
      help: loadHelp(),
    }),

    'POST /api/draft': async (req) => {
      const body = await readJson(req);
      const key = storyKey(body.story);
      const stopped = () => ({ risk: { level: 'urgent', byModel: true, matches: [] }, help: helpMessage('urgent') });
      if (blocked.has(key)) return stopped();
      const result = await makeDraft(body.story, {
        date: body.date, period: body.period, tone: body.tone, provider: body.provider,
      });
      if (!result.episode) {
        if (result.risk.byModel) blocked.add(key);
        return { risk: result.risk, help: helpMessage(result.risk.level) };
      }
      // Остановка, пришедшая из параллельного запроса, пока модель писала черновик, важнее черновика.
      if (blocked.has(key)) return stopped();
      return {
        episode: result.episode, validation: result.validation, risk: result.risk,
        provider: result.provider, note: result.note, dropped: result.dropped,
        help: result.risk.level === 'concern' ? helpMessage('concern') : null,
      };
    },

    'POST /api/validate': async (req) => {
      const body = await readJson(req);
      const ep = sanitizeEpisode(body.episode);
      return { episode: ep, validation: validateEpisode(ep, String(body.story || '')), text: episodeToText(ep) };
    },

    'POST /api/render': async (req) => {
      const body = await readJson(req);
      const ep = sanitizeEpisode(body.episode);
      const story = String(body.story || '');
      const stop = (risk) => ({ status: 422, body: { error: 'Ролик не собирается: сработал фильтр безопасности.', risk, help: helpMessage('urgent') } });
      const risk = assessEpisodeRisk(story, ep);
      if (risk.level === 'urgent') return stop(risk);
      const v = validateEpisode(ep, story);
      if (!v.ok) return { status: 422, body: { error: 'Исправьте ошибки перед рендером.', validation: v } };
      // Вердикт модели привязан к рассказу: повторный запрос его не снимает.
      // Инвариант: после остановки по ключу рассказа ни один запрос с этим ключом не запускает рендер и не отдаёт ролик.
      // Ответ «можно» никогда не снимает остановку — ни повторный, ни пришедший позже из параллельного запроса.
      const key = storyKey(story);
      const modelStop = () => stop({ level: 'urgent', byModel: true, matches: [] });
      if (blocked.has(key)) return modelStop();
      let flagged;
      try { flagged = await safetyCheck(`${story}\n${episodeToText(ep)}`); }
      catch { return { status: 503, body: { error: 'Не удалось проверить рассказ на безопасность. Ролик не собирается, попробуйте позже.' } }; }
      if (flagged === true) blocked.add(key);
      // Проверка после ожидания: остановка могла прийти из параллельного запроса, пока ждали модель.
      if (blocked.has(key)) return modelStop();
      const id = `${ep.date}-${safeName(body.participant, 'p')}-${crypto.randomBytes(3).toString('hex')}`;
      const files = [path.join(OUT, `${id}.mp4`), path.join(OUT, `${id}.jpg`)];
      const STOPPED = Symbol('stopped');
      const job = rendering.then(() => {
        // Проверка при запуске из очереди: остановка могла прийти, пока задача ждала.
        if (blocked.has(key)) return STOPPED;
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
      if (blocked.has(key)) {
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
      console.error(e.message);
      const status = e.status || (e.code === 'safety' ? 422 : 500);
      send(res, status, { error: e.status || e.code === 'safety' ? e.message : 'Ошибка сервера: ' + e.message, validation: e.validation });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`Монтажная: http://127.0.0.1:${port}/`);
    console.log(hasClaudeCredentials() ? `Черновики: Claude (${DEFAULT_MODEL})` : 'Черновики: заготовка без ИИ (ключ ANTHROPIC_API_KEY не задан)');
  });
}
