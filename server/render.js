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
    browserPromise = chromium.launch(executablePath ? { executablePath } : {});
  }
  return browserPromise;
}

export async function closeRenderer() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

function runFfmpeg(args, feed) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg завершился с кодом ${code}: ${err}`))));
    feed(p.stdin).then(() => p.stdin.end(), (e) => { p.kill('SIGKILL'); reject(e); });
  });
}

/**
 * Отрендерить эпизод в MP4.
 * options: { story (обязательно), outPath, preset: 'preview'|'standard'|'hd', duration, still, watermark, posterPath }
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

  const server = await serveEngine();
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
  const started = Date.now();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/render.html`);
    await page.waitForFunction(() => window.titryReady === true);
    const fontsOk = await page.evaluate(([e, o]) => window.titrySetup(e, o), [ep, {
      width: preset.width, height: preset.height, fps: preset.fps, quality: preset.quality,
      duration: T.duration, still: !!options.still, watermark: options.watermark ?? false,
      timing: options.timing || 'v1', typo: options.typo || 'v1', ease: options.ease || 'smooth',
    }]);
    if (!fontsOk) throw new Error('Шрифты бренда не загрузились, рендер остановлен, чтобы не выпустить ролик с системным шрифтом.');

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
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-metadata', 'title=' + ep.title, outPath);

    const batch = 12;
    await runFfmpeg(args, async (stdin) => {
      for (let f = 0; f < frames; f += batch) {
        const chunk = await page.evaluate(([a, b]) => window.titryFrames(a, b), [f, Math.min(batch, frames - f)]);
        for (const b64 of chunk) {
          if (!stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => stdin.once('drain', r));
        }
      }
    });

    let posterPath = null;
    if (options.posterPath) {
      posterPath = path.resolve(options.posterPath);
      const [b64] = await page.evaluate(([f]) => window.titryFrames(f, 1), [Math.round((T.titleHold - 0.5) * preset.fps)]);
      await fs.writeFile(posterPath, Buffer.from(b64, 'base64'));
    }
    return { outPath, posterPath, seconds: (Date.now() - started) / 1000, frames, duration: T.duration };
  } finally {
    await page.close();
    server.close();
  }
}
