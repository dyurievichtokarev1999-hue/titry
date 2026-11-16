// Серверный рендер ролика: Chromium без окна рисует кадры тем же draw.js, ffmpeg собирает MP4 9:16.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TRACKS, validateEpisode } from '../engine/episode.js';
import { DEFAULT_DURATION, timeline } from '../engine/draw.js';
import { assessEpisodeRisk } from './safety.js';
import { logError } from './errlog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const ENGINE = path.join(ROOT, 'engine');
const AUDIO = path.join(ROOT, 'assets', 'audio');

export const PRESETS = {
  preview: { width: 540, height: 960, fps: 24, quality: 0.85, crf: 26 },
  standard: { width: 720, height: 1280, fps: 30, quality: 0.9, crf: 21 },
  hd: { width: 1080, height: 1920, fps: 30, quality: 0.92, crf: 19 },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };

/** Крошечный статический сервер только для папки engine: страница рендера грузит модули и шрифты. */
function serveEngine() {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'render.html';
      const file = path.resolve(ENGINE, rel);
      if (!file.startsWith(ENGINE + path.sep) || !MIME[path.extname(file)]) { res.writeHead(404).end(); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright');
    const executablePath = process.env.TITRY_CHROMIUM || undefined;
    // Неудачный запуск не кэшируем: следующий рендер попробует снова, а ошибка понятна без стека Playwright.
    browserPromise = chromium.launch(executablePath ? { executablePath } : {}).catch((cause) => {
      browserPromise = null;
      const where = executablePath ? `TITRY_CHROMIUM=${executablePath}` : 'браузер Playwright по умолчанию';
      throw Object.assign(new Error(`Chromium не запустился (${where}). Укажите установленный Chromium в TITRY_CHROMIUM или установите браузер под версию Playwright из package-lock.json.`), { code: 'browser', cause });
    });
  }
  return browserPromise;
}

export async function closeRenderer() {
  // После неудачного запуска закрывать нечего: ошибку уже получил рендер, здесь её не повторяем.
  if (browserPromise) { const b = await browserPromise.catch(() => null); browserPromise = null; if (b) await b.close(); }
}

// Предел активного рендера (решение владельца кода 16.11): отсчёт от старта задачи в слоте очереди, не от постановки
// в очередь. Замер и выбор значения — docs/DECISIONS.md. Переменная окружения TITRY_RENDER_TIMEOUT_MS.
export const RENDER_TIMEOUT_MS = 180 * 1000;
// Сколько ждать выхода FFmpeg после SIGTERM, прежде чем послать SIGKILL.
export const KILL_GRACE_MS = 5000;

/** Предел из окружения. Неположительное или нечисловое значение — значение по умолчанию и одна строка в журнал. */
export function renderTimeoutFromEnv({ env = process.env, log = console.error } = {}) {
  const raw = env.TITRY_RENDER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return RENDER_TIMEOUT_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && Math.round(n) > 0) return Math.round(n); // «0.4» округлилось бы до 0 — как неверное
  // Только этап и код, без значения переменной.
  log(JSON.stringify({ at: new Date().toISOString(), level: 'warn', stage: 'render.timeout', code: 'render_timeout_config', ms: RENDER_TIMEOUT_MS }));
  return RENDER_TIMEOUT_MS;
}

/**
 * Остановить процесс: SIGTERM, через graceMs без выхода — SIGKILL. Промис выполняется после выхода процесса
 * или сразу после SIGKILL; значение — последний посланный сигнал (null, если процесс уже завершился).
 * proc — ChildProcess или подставной EventEmitter с kill(), exitCode и signalCode.
 */
export function killWithGrace(proc, { graceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) return resolve(null);
    let timer;
    const done = (sig) => { clearTimeout(timer); proc.removeListener('exit', onExit); resolve(sig); };
    const onExit = () => done('SIGTERM');
    proc.once('exit', onExit);
    timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* уже вышел */ } done('SIGKILL'); }, graceMs);
    try { proc.kill('SIGTERM'); } catch { /* уже вышел */ }
  });
}

export const renderTimeoutError = (ms) => Object.assign(new Error('render_timeout'), { code: 'render_timeout', ms });

/** Удалить файлы; ошибка удаления — в журнал только код, без путей (пути могут содержать текст). */
export async function removeQuiet(files) {
  for (const f of files) {
    if (!f) continue;
    try { await fs.rm(f, { force: true }); } catch (e) { logError('render.cleanup', e); }
  }
}

/**
 * Задача рендера с пределом: run(signal) получает AbortSignal, который срабатывает через timeoutMs от вызова
 * (вызывать при старте задачи в слоте). Промис выполняется только после того, как run завершился (процесс вышел
 * или получил SIGKILL), — слот до этого не освобождается. После отмены результат отбрасывается, files и файлы
 * результата удаляются, бросается ошибка с кодом render_timeout и длительностью ms.
 */
export async function withRenderTimeout(run, timeoutMs = RENDER_TIMEOUT_MS, { files = [], graceMs = KILL_GRACE_MS } = {}) {
  const ac = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => ac.abort(renderTimeoutError(timeoutMs)), timeoutMs);
  // Запасной предел (timeout + 2×grace): если рендер не завершился и после отмены (например, завис запуск браузера
  // до подписки на сигнал), слот освобождается принудительно; поздний результат отбрасывается и его файлы удаляются.
  let backstop;
  const forced = new Promise((resolve) => { backstop = setTimeout(() => resolve(FORCED), timeoutMs + 2 * graceMs); });
  const work = Promise.resolve().then(() => run(ac.signal));
  try {
    const r = await Promise.race([work, forced]);
    if (r === FORCED) {
      await removeQuiet(files);
      work.then((late) => removeQuiet([late?.outPath, late?.posterPath, ...files]), () => removeQuiet(files));
      throw Object.assign(renderTimeoutError(Date.now() - started), { forced: true });
    }
    if (!ac.signal.aborted) return r;
    await removeQuiet([r?.outPath, r?.posterPath, ...files]); // поздний результат отменённой задачи
  } catch (e) {
    if (e?.forced) throw e;
    if (!ac.signal.aborted) throw e;
    await removeQuiet(files);
  } finally { clearTimeout(timer); clearTimeout(backstop); }
  throw renderTimeoutError(Date.now() - started);
}
const FORCED = Symbol('forced');

function runFfmpeg(args, feed, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    let stopping = null;
    // Отмена: подача кадров прекращается (feed видит signal.aborted), stdin закрывается, SIGTERM → SIGKILL.
    // Промис отклоняется только после выхода процесса или SIGKILL.
    const onAbort = () => {
      if (stopping) return;
      p.stdin.destroy();
      stopping = killWithGrace(p).then(() => reject(signal.reason || renderTimeoutError(0)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdin.on('error', () => {}); // EPIPE после закрытия при отмене
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (stopping) return;
      if (code === 0) resolve(); else reject(Object.assign(new Error(`ffmpeg завершился с кодом ${code}: ${err}`), { code: 'ffmpeg' }));
    });
    if (signal?.aborted) { onAbort(); return; }
    feed(p.stdin).then(() => { if (!stopping) p.stdin.end(); }, (e) => { if (stopping) return; p.kill('SIGKILL'); reject(e); });
  });
}

/**
 * Отрендерить эпизод в MP4.
 * options: { story (обязательно), outPath, preset: 'preview'|'standard'|'hd', duration, still, watermark, posterPath, signal }
 * signal — AbortSignal задачи (предел активного рендера): кадры перестают подаваться, FFmpeg и страница закрываются,
 * частичные MP4 и постер удаляются.
 * story — опора эпизода: рассказ человека и его собственные правки. Без неё рендер не запускается.
 * Возвращает { outPath, posterPath, seconds, frames }.
 */
export async function renderEpisode(ep, options = {}) {
  // Последняя линия защиты для любого пути (монтажная, бот, CLI): опасные темы — без ролика.
  const risk = assessEpisodeRisk(options.story, ep);
  if (risk.level === 'urgent') {
    throw Object.assign(new Error('Рендер остановлен фильтром безопасности: в рассказе или строках есть опасные темы.'), { code: 'safety', risk });
  }
  const check = validateEpisode(ep, options.story);
  if (!check.ok) {
    const e = new Error('Эпизод не готов к рендеру: ' + check.errors.map((x) => x.msg).join(' '));
    e.validation = check;
    throw e;
  }
  const preset = { ...PRESETS[options.preset || 'standard'] };
  const duration = options.duration || DEFAULT_DURATION;
  const T = timeline(duration, options.timing);
  const frames = Math.round(T.duration * preset.fps);
  const outPath = path.resolve(options.outPath || path.join(ROOT, 'data', 'out', `titry-${Date.now()}.mp4`));
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // Сначала браузер, потом сервер: если Chromium не запустился, открытого сервера не остаётся и процесс завершается сам.
  const browser = await getBrowser();
  const server = await serveEngine();
  let page = null;
  let done = false;
  let written = false; // FFmpeg запущен: файл по outPath уже наш
  const started = Date.now();
  const signal = options.signal;
  // Отмена задачи закрывает страницу этой задачи: идущий page.evaluate прерывается, кадры больше не рисуются.
  const closePage = () => { if (page) page.close().catch(() => {}); };
  signal?.addEventListener('abort', closePage, { once: true });
  try {
    if (signal?.aborted) throw signal.reason;
    page = await browser.newPage({ viewport: { width: 200, height: 200 } });
    if (signal?.aborted) throw signal.reason;
    await page.goto(`http://127.0.0.1:${server.address().port}/render.html`);
    await page.waitForFunction(() => window.titryReady === true);
    const fontsOk = await page.evaluate(([e, o]) => window.titrySetup(e, o), [ep, {
      width: preset.width, height: preset.height, fps: preset.fps, quality: preset.quality,
      duration: T.duration, still: !!options.still, watermark: options.watermark ?? false,
      timing: options.timing || 'v1', typo: options.typo || 'v1', ease: options.ease || 'smooth',
    }]);
    if (!fontsOk) throw Object.assign(new Error('Шрифты бренда не загрузились, рендер остановлен, чтобы не выпустить ролик с системным шрифтом.'), { code: 'fonts' });

    const track = TRACKS[ep.music] || TRACKS.none;
    const audioFile = track.file ? path.join(AUDIO, track.file) : null;
    const fadeOutStart = Math.max(0, T.duration - 2.6).toFixed(2);
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(preset.fps), '-i', 'pipe:0'];
    if (audioFile) args.push('-i', audioFile);
    args.push('-map', '0:v');
    if (audioFile) {
      args.push('-map', '1:a', '-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutStart}:d=2.4`, '-c:a', 'aac', '-b:a', '160k');
    }
    args.push('-t', T.duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(preset.crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath);
    // Заголовок эпизода не передаётся в командную строку ffmpeg (И2): argv виден другим процессам хоста.
    // Видимый заголовок остаётся в кадре; метаданных title в файле нет.

    const batch = 12;
    written = true;
    await runFfmpeg(args, async (stdin) => {
      for (let f = 0; f < frames && !signal?.aborted; f += batch) {
        const chunk = await page.evaluate(([a, b]) => window.titryFrames(a, b), [f, Math.min(batch, frames - f)]);
        for (const b64 of chunk) {
          if (signal?.aborted) return;
          if (!stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => { const go = () => { stdin.off('drain', go); stdin.off('close', go); r(); }; stdin.on('drain', go); stdin.on('close', go); });
        }
      }
    }, signal);
    if (signal?.aborted) throw signal.reason;

    let posterPath = null;
    if (options.posterPath) {
      posterPath = path.resolve(options.posterPath);
      const [b64] = await page.evaluate(([f]) => window.titryFrames(f, 1), [Math.round((T.titleHold - 0.5) * preset.fps)]);
      await fs.writeFile(posterPath, Buffer.from(b64, 'base64'));
    }
    if (signal?.aborted) throw signal.reason;
    done = true;
    return { outPath, posterPath, seconds: (Date.now() - started) / 1000, frames, duration: T.duration };
  } catch (e) {
    throw signal?.aborted ? signal.reason : e;
  } finally {
    signal?.removeEventListener('abort', closePage);
    server.close();
    if (page) await page.close().catch(() => {});
    // Неудача или отмена: частичный MP4 и постер не остаются на диске.
    if (!done && written) await removeQuiet([outPath, options.posterPath && path.resolve(options.posterPath)]);
  }
}
