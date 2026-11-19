// Аудит 17.11, пп. 5–7: браузер после падения, сбой записи метрик, зависший SpeechKit.
// Только вымышленные рассказы; модель, Telegram, метрики и SpeechKit подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TEXT } from '../server/bot.js';
import { CONSENT_TEXT } from '../server/consent.js';
import { createBot } from './helpers/consent.js'; // подтверждения 6А–6Ж пройдены (хелпер)
import { makeDraft } from '../server/draft.js';
import { transcribeOgg } from '../server/stt.js';
import { renderEpisode, closeRenderer, getBrowser } from '../server/render.js';
import { fakeModelClient } from './helpers/fake-model.js';

const STORY = 'Утром я пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.';

test('п. 6: metrics.log бросает ENOSPC — человек получает ответ на /start, черновик и ролик', async () => {
  const sent = []; let video = 0; let logs = 0;
  const metrics = { hash: () => 'h', forget: async () => {}, log: async () => { logs++; throw Object.assign(new Error('нет места'), { code: 'ENOSPC' }); } };
  const tg = { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { video++; } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-a57-'));
  const render = async (ep, o) => { await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; };
  const bot = createBot({ tg, metrics, render, checkRetryMs: 0, safetyCheck: async () => false,
    draft: (st, o) => makeDraft(st, { ...o, provider: 'claude', client: fakeModelClient(), retryDelayMs: 0 }) });
  const chat = { id: 717001, type: 'private' };
  const errs = []; const orig = console.error; console.error = (l) => errs.push(String(l));
  try {
    await bot.handleUpdate({ message: { chat, text: '/start' } });
    assert.equal(sent.at(-1).text, CONSENT_TEXT.intro); // /start начинает с 6А (PR 24)
    await bot.handleUpdate({ message: { chat, text: STORY } });
    assert.ok(sent.some((m) => /Похоже на твой день/.test(m.text)), 'черновик показан');
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
    assert.equal(video, 1);
    assert.ok(!sent.some((x) => x.text === TEXT.renderFail), 'нет «Не получилось собрать ролик»');
  } finally { console.error = orig; await fs.rm(dir, { recursive: true, force: true }); }
  assert.ok(logs >= 4);
  const log = errs.join('\n');
  assert.match(log, /ENOSPC/);
  assert.ok(!/нет места|чай|посуд/.test(log), 'в журнале только код');
});

test('п. 7: зависший SpeechKit — отказ по пределу, голос удалён с диска', async () => {
  const saved = { k: process.env.YANDEX_API_KEY, f: process.env.YANDEX_FOLDER_ID, fetch: globalThis.fetch };
  process.env.YANDEX_API_KEY = 'dummy-not-a-key'; process.env.YANDEX_FOLDER_ID = 'dummy';
  // fetch, который отвечает только на отмену сигналом.
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-a57-stt-'));
  const keep = setInterval(() => {}, 1000); // таймер AbortSignal.timeout не держит процесс; в боте его держит опрос Telegram
  try {
    await assert.rejects(transcribeOgg(Buffer.from('ogg'), { runtimeDir: base, timeoutMs: 50 }), { name: 'TimeoutError' });
    assert.deepEqual((await fs.readdir(base)).filter((n) => n.startsWith('titry-voice-')), [], 'голос удалён');
  } finally {
    clearInterval(keep);
    globalThis.fetch = saved.fetch;
    if (saved.k === undefined) delete process.env.YANDEX_API_KEY; else process.env.YANDEX_API_KEY = saved.k;
    if (saved.f === undefined) delete process.env.YANDEX_FOLDER_ID; else process.env.YANDEX_FOLDER_ID = saved.f;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('п. 7: второй кусок завис после HTTP 200 — ошибка без частичной расшифровки, голос удалён', async () => {
  const saved = { k: process.env.YANDEX_API_KEY, f: process.env.YANDEX_FOLDER_ID, fetch: globalThis.fetch };
  process.env.YANDEX_API_KEY = 'dummy-not-a-key'; process.env.YANDEX_FOLDER_ID = 'dummy';
  let calls = 0;
  globalThis.fetch = async (url, { signal }) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ result: 'Утром я пила чай.' }), { status: 200 });
    // Заголовки пришли (200), тело так и не дочитывается — до отмены сигналом.
    return { ok: true, status: 200, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  };
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-a57-stt2-'));
  const keep = setInterval(() => {}, 1000); // таймер AbortSignal.timeout не держит процесс
  const split = async (src, dir) => Promise.all(['part-000.ogg', 'part-001.ogg'].map(async (n) => { const p = path.join(dir, n); await fs.writeFile(p, 'ogg'); return p; }));
  try {
    await assert.rejects(transcribeOgg(Buffer.from('ogg'), { runtimeDir: base, timeoutMs: 50, duration: 60, split }), { name: 'TimeoutError' });
    assert.equal(calls, 2);
    assert.deepEqual((await fs.readdir(base)).filter((n) => n.startsWith('titry-voice-')), [], 'голос и куски удалены');
  } finally {
    clearInterval(keep);
    globalThis.fetch = saved.fetch;
    if (saved.k === undefined) delete process.env.YANDEX_API_KEY; else process.env.YANDEX_API_KEY = saved.k;
    if (saved.f === undefined) delete process.env.YANDEX_FOLDER_ID; else process.env.YANDEX_FOLDER_ID = saved.f;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('п. 7: распознавание не удалось — обычный ответ «не получилось разобрать»', async () => {
  const sent = [];
  const tg = { send: async (id, text) => { sent.push(text); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from('ogg'), sendVideo: async () => {} };
  const metrics = { hash: () => 'h', forget: async () => {}, log: async () => {} };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false,
    transcribe: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } });
  await bot.handleUpdate({ message: { chat: { id: 717002, type: 'private' }, voice: { file_id: 'f', duration: 5 } } });
  assert.equal(sent.at(-1), TEXT.voiceEmpty);
});

let available = true;
try { createRequire(import.meta.url)('playwright'); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { available = false; }

test('п. 5: браузер закрылся — следующий рендер проходит', { skip: !available && 'нет playwright или ffmpeg', timeout: 120000 }, async () => {
  const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-a57-render-'));
  try {
    const first = await getBrowser();
    await first.close(); // как падение Chromium: событие disconnected
    const r = await renderEpisode(ex.episode, { story: ex.story, outPath: path.join(dir, 'x.mp4'), preset: 'preview', duration: 16 });
    assert.ok((await fs.stat(r.outPath)).size > 1000);
    assert.notEqual(await getBrowser(), first, 'запущен новый браузер');
  } finally { await closeRenderer(); await fs.rm(dir, { recursive: true, force: true }); }
});
