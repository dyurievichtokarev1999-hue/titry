// Распознавание голосовых сообщений Telegram (OGG/Opus) через Yandex SpeechKit, синхронный API v1.
// Синхронный API принимает до 30 секунд и 1 МБ, поэтому длинное голосовое режем на куски по 25 секунд
// без перекодирования (ffmpeg -c copy) и распознаём по очереди.
// Ключи: YANDEX_API_KEY (API-ключ сервисного аккаунта) и YANDEX_FOLDER_ID.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Временные файлы голосовых (voice.ogg, part-*.ogg) — в каталоге задач TITRY_RUNTIME_DIR (И1, план архитектора):
// каталог 0700, каталог задачи 0700, файлы 0600. При старте удаляются только остатки собственных задач
// (каталоги titry-voice-XXXXXX), остальное в каталоге не трогается.
export const VOICE_JOB = /^titry-voice-[A-Za-z0-9]{6}$/;
export function runtimeDir() { return process.env.TITRY_RUNTIME_DIR || path.join(os.tmpdir(), 'titry-runtime'); }
async function ensureRuntime(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

/** Удалить остатки прежних задач распознавания (после аварии). Возвращает число удалённых каталогов. */
export async function cleanupVoiceOrphans(dir = runtimeDir()) {
  let removed = 0;
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e?.code === 'ENOENT') return 0; throw e; }
  for (const d of entries) {
    // Только собственные каталоги задач; ссылки и файлы с похожим именем не трогаем.
    if (!d.isDirectory() || !VOICE_JOB.test(d.name)) continue;
    await fs.rm(path.join(dir, d.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

const ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
const CHUNK_SECONDS = 25;
export const MAX_VOICE_SECONDS = 180;

export function sttAvailable() {
  return Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${err}`))));
  });
}

/** Разрезать OGG/Opus на куски без перекодирования. Возвращает пути к кускам. */
export async function splitOgg(file, dir) {
  const pattern = path.join(dir, 'part-%03d.ogg');
  await run(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1', '-c', 'copy', pattern]);
  const parts = (await fs.readdir(dir)).filter((f) => f.startsWith('part-')).sort().map((f) => path.join(dir, f));
  for (const p of parts) await fs.chmod(p, 0o600);
  return parts;
}

async function recognizeChunk(buf, { lang = 'ru-RU' } = {}) {
  const url = `${ENDPOINT}?lang=${encodeURIComponent(lang)}&format=oggopus&folderId=${encodeURIComponent(process.env.YANDEX_FOLDER_ID)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}` },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`SpeechKit ${res.status}: ${data.error_message || data.message || 'ошибка'}`), { status: res.status });
  return String(data.result || '').trim();
}

/** Распознать голосовое. Временные файлы удаляются сразу после распознавания. */
export async function transcribeOgg(buf, opts = {}) {
  if (!sttAvailable()) throw Object.assign(new Error('Распознавание речи не настроено.'), { code: 'stt_off' });
  const base = opts.runtimeDir || runtimeDir();
  await ensureRuntime(base);
  const dir = await fs.mkdtemp(path.join(base, 'titry-voice-')); // создаётся с правами 0700
  try {
    const src = path.join(dir, 'voice.ogg');
    await fs.writeFile(src, buf, { mode: 0o600 });
    const parts = buf.length < 900_000 && (opts.duration || 0) <= 28 ? [src] : await (opts.split || splitOgg)(src, dir);
    const texts = [];
    for (const p of parts) texts.push(await (opts.recognize || recognizeChunk)(await fs.readFile(p), opts));
    return texts.filter(Boolean).join(' ');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
