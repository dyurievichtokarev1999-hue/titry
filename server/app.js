// Монтажная: локальный сервер для консьерж-теста.
// Рассказ → черновик → правка строк → предпросмотр → MP4 для участника.
// Слушает только 127.0.0.1. Запуск: npm run studio
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MOODS, TRACKS, sanitizeEpisode, validateEpisode, episodeToText } from '../engine/episode.js';
import { makeDraft, hasClaudeCredentials, DEFAULT_MODEL } from './draft.js';
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
const bool = (v) => v === true;

/** Запись журнала: только разрешённые поля, без текстов. */
export function logRecord(body) {
  const ep = sanitizeEpisode(body.episode);
  const fb = body.feedback && typeof body.feedback === 'object' ? body.feedback : {};
  const edits = fb.edits && typeof fb.edits === 'object' ? fb.edits : {};
  return {
    savedAt: new Date().toISOString(),
    participant: safeName(body.participant, ''),
    day: int(Number(body.day), 1, 30),
    date: ep.date,
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
export function createApp({ render = renderEpisode, dataDir = path.join(ROOT, 'data') } = {}) {
  const OUT = path.join(dataDir, 'out');
  const LOG = path.join(dataDir, 'concierge');
  let rendering = Promise.resolve();

  const routes = {
    'GET /api/config': async () => ({
      provider: hasClaudeCredentials() ? 'claude' : 'manual',
      model: hasClaudeCredentials() ? DEFAULT_MODEL : null,
      help: loadHelp(),
    }),

    'POST /api/draft': async (req) => {
      const body = await readJson(req);
      const result = await makeDraft(body.story, {
        date: body.date, period: body.period, tone: body.tone, provider: body.provider,
      });
      if (!result.episode) return { risk: result.risk, help: helpMessage(result.risk.level) };
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
      const risk = assessEpisodeRisk(story, ep);
      if (risk.level === 'urgent') return { status: 422, body: { error: 'Ролик не собирается: сработал фильтр безопасности.', risk, help: helpMessage('urgent') } };
      const v = validateEpisode(ep, story);
      if (!v.ok) return { status: 422, body: { error: 'Исправьте ошибки перед рендером.', validation: v } };
      const id = `${ep.date}-${safeName(body.participant, 'p')}-${crypto.randomBytes(3).toString('hex')}`;
      const job = rendering.then(() => render(ep, {
        story,
        outPath: path.join(OUT, `${id}.mp4`), posterPath: path.join(OUT, `${id}.jpg`),
        preset: ['preview', 'standard', 'hd'].includes(body.preset) ? body.preset : 'standard',
        still: !!body.still, watermark: body.watermark ? 'сделано в титрах' : false,
      }));
      rendering = job.catch(() => {});
      const r = await job;
      return { video: `/out/${id}.mp4`, poster: `/out/${id}.jpg`, seconds: r.seconds, validation: v };
    },

    // Журнал консьерж-теста: только события и числа (см. logRecord). Хранится локально в data/concierge.
    'POST /api/log': async (req) => {
      const body = await readJson(req);
      if (!body.consent) return { status: 400, body: { error: 'Нет отметки о согласии участника.' } };
      const record = logRecord(body);
      if (!record.participant) return { status: 400, body: { error: 'Укажите код участника латиницей, например p07.' } };
      const dir = path.join(LOG, record.participant);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${record.date}-${Date.now()}.json`);
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
