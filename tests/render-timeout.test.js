// Предел активного рендера (решение владельца кода 16.11). Настоящий createBot; подставные: черновик (вымышленный
// examples/day-quiet.json), отдельная проверка, рендер (таймер ~50 мс), Telegram. Реальный FFmpeg не нужен:
// слой остановки процесса проверяется на подставном процессе-эмиттере.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBot, TEXT } from '../server/bot.js';
import { killWithGrace, renderTimeoutFromEnv, RENDER_TIMEOUT_MS } from '../server/render.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-rt-'));
process.env.TITRY_BOT_TMP_DIR = tmp;
test.after(() => fs.rm(tmp, { recursive: true, force: true }));

const LIMIT = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (f) => fs.access(f).then(() => true, () => false);
const aborted = (signal) => new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', r, { once: true })));

// Подставной процесс: kill() записывает сигнал; ignoreTerm — SIGTERM не завершает процесс.
function fakeProc({ ignoreTerm = false } = {}) {
  const p = new EventEmitter();
  p.exitCode = null; p.signalCode = null; p.signals = [];
  p.kill = (sig) => {
    p.signals.push(sig);
    if (sig === 'SIGTERM' && ignoreTerm) return true;
    setImmediate(() => { p.signalCode = sig; p.emit('exit', null, sig); });
    return true;
  };
  return p;
}

// behave(chatId, o) — поведение подставного рендера для чата; по умолчанию — быстрый ролик.
function setup(behave = {}) {
  const sent = []; const videos = []; const events = []; const log = { kills: [], outs: {}, starts: [] };
  const tg = {
    send: async (c, text) => { sent.push({ c, text }); },
    action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c) => { videos.push(c); },
  };
  const metrics = { hash: (id) => `h${id}`, log: async (id, ev, extra = {}) => { events.push({ id, ev, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, checkRetryMs: 0, renderTimeoutMs: LIMIT,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    safetyCheck: async () => false,
    render: async (ep, o) => {
      const id = Number(path.basename(o.outPath).slice(1).split('-')[0]);
      log.starts.push({ id, at: Date.now() });
      log.outs[id] = o.outPath;
      await fs.writeFile(o.outPath, 'частичный файл');
      if (behave[id]) return behave[id](o, log, id);
      await sleep(5);
      return { seconds: 0, duration: 24, outPath: o.outPath };
    },
  });
  const chat = (id) => ({ id, type: 'private' });
  const say = (id, text) => bot.handleUpdate({ message: { chat: chat(id), text } });
  const play = (id) => bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat: chat(id) } } });
  const textsTo = (id) => sent.filter((m) => m.c === id).map((m) => m.text);
  return { bot, sent, videos, events, log, say, play, textsTo };
}

// Рендер, который ждёт отмены и «убивает» свой процесс; затем отклоняется.
const hangUntilAbort = (opts = {}) => async (o, log, id) => {
  const proc = fakeProc(opts);
  await aborted(o.signal);
  const sig = await killWithGrace(proc, { graceMs: opts.graceMs ?? 20 });
  log.kills.push({ id, sig, signals: proc.signals.slice(), at: Date.now() });
  throw Object.assign(new Error('page closed'), { code: 'EPIPE' });
};

test('A ждёт до отмены, B в очереди: kill A, MP4 A удалён, 0 видео A, одна техническая реплика; B — видео; C принят', async () => {
  const A = 81001, B = 81002, C = 81003;
  const b = setup({ [A]: hangUntilAbort() });
  const logs = [];
  const origErr = console.error; console.error = (line) => logs.push(String(line));
  try {
    await b.say(A, ex.story); await b.say(B, ex.story);
    const pa = b.play(A); const pb = b.play(B);
    await Promise.all([pa, pb]);
    assert.equal(b.log.kills.length, 1, 'процесс A остановлен');
    assert.equal(b.log.kills[0].id, A);
    assert.equal(await exists(b.log.outs[A]), false, 'MP4 A удалён');
    assert.equal(b.videos.filter((c) => c === A).length, 0);
    assert.equal(b.textsTo(A).filter((t) => t === TEXT.renderFail).length, 1, 'ровно одна техническая реплика');
    assert.equal(b.textsTo(A).filter((t) => t === TEXT.tryLater()).length, 0);
    assert.equal(b.videos.filter((c) => c === B).length, 1, 'B доставлен');
    const startB = b.log.starts.find((s) => s.id === B).at;
    assert.ok(startB >= b.log.kills[0].at, 'B стартует после освобождения слота');
    // Новый запрос принимается и даёт видео.
    await b.say(C, ex.story); await b.play(C);
    assert.equal(b.videos.filter((c) => c === C).length, 1);
    assert.ok(!b.textsTo(C).includes(TEXT.busy));
  } finally { console.error = origErr; }
  // Журнал и метрики: только код и длительность, без текстов и путей.
  const line = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && j.code === 'render_timeout');
  assert.ok(line, 'строка render_timeout в журнале');
  assert.deepEqual(Object.keys(line).sort(), ['at', 'code', 'level', 'ms', 'stage', 'version']);
  assert.ok(line.ms >= LIMIT);
  assert.ok(!logs.some((l) => l.includes(tmp) || l.includes(ex.story.slice(0, 15))));
  const ev = b.events.filter((e) => e.ev === 'render_timeout');
  assert.equal(ev.length, 1);
  assert.deepEqual(Object.keys(ev[0]).sort(), ['ev', 'id', 'ms']);
});

test('сессия A неактуальна (/delete во время рендера) → 0 сообщений по A после удаления', async () => {
  const A = 81011;
  const b = setup({ [A]: hangUntilAbort() });
  await b.say(A, ex.story);
  const pa = b.play(A);
  await sleep(10);
  await b.say(A, '/delete');
  const before = b.textsTo(A).length;
  await pa;
  assert.equal(b.log.kills.length, 1);
  assert.equal(b.textsTo(A).length, before, 'после /delete по отменённой задаче ничего не отправлено');
  assert.equal(b.videos.length, 0);
  assert.equal(await exists(b.log.outs[A]), false);
  assert.equal(b.events.filter((e) => e.ev === 'render_timeout').length, 0, 'новой записи о человеке после /delete нет');
});

test('процесс игнорирует SIGTERM → SIGKILL, слот свободен', async () => {
  const A = 81021, B = 81022;
  const b = setup({ [A]: hangUntilAbort({ ignoreTerm: true, graceMs: 30 }) });
  await b.say(A, ex.story); await b.say(B, ex.story);
  await Promise.all([b.play(A), b.play(B)]);
  assert.equal(b.log.kills[0].sig, 'SIGKILL');
  assert.deepEqual(b.log.kills[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(b.videos.filter((c) => c === B).length, 1, 'следующая задача прошла');
  assert.ok(b.log.starts.find((s) => s.id === B).at >= b.log.kills[0].at);
});

test('A «доезжает» после отмены → 0 отправок видео, файл удалён', async () => {
  const A = 81031;
  const b = setup({
    [A]: async (o, log, id) => {
      await aborted(o.signal);
      log.kills.push({ id });
      await sleep(30); // процесс всё же дописал ролик
      await fs.writeFile(o.outPath, 'готовый файл');
      return { seconds: 1, duration: 24, outPath: o.outPath };
    },
  });
  await b.say(A, ex.story);
  await b.play(A);
  assert.equal(b.videos.length, 0);
  assert.equal(await exists(b.log.outs[A]), false);
  assert.equal(b.textsTo(A).filter((t) => t === TEXT.renderFail).length, 1);
});

test('killWithGrace: процесс выходит по SIGTERM — SIGKILL не посылается', async () => {
  const p = fakeProc();
  assert.equal(await killWithGrace(p, { graceMs: 1000 }), 'SIGTERM');
  assert.deepEqual(p.signals, ['SIGTERM']);
  const done = fakeProc(); done.exitCode = 0;
  assert.equal(await killWithGrace(done, { graceMs: 10 }), null);
  assert.deepEqual(done.signals, []);
});

test('TITRY_RENDER_TIMEOUT_MS: «0», «-5», «abc» → 180000 и одна строка предупреждения; «90000» → 90000', () => {
  assert.equal(RENDER_TIMEOUT_MS, 180000);
  for (const v of ['0', '-5', 'abc']) {
    const lines = [];
    assert.equal(renderTimeoutFromEnv({ env: { TITRY_RENDER_TIMEOUT_MS: v }, log: (l) => lines.push(l) }), 180000);
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.equal(j.level, 'warn'); assert.equal(j.code, 'render_timeout_config'); assert.ok(j.at && j.stage);
    assert.ok(!lines[0].includes(v === '0' ? '"0"' : v), 'значение переменной в журнал не пишется');
  }
  const lines = [];
  assert.equal(renderTimeoutFromEnv({ env: { TITRY_RENDER_TIMEOUT_MS: '90000' }, log: (l) => lines.push(l) }), 90000);
  assert.equal(renderTimeoutFromEnv({ env: {}, log: (l) => lines.push(l) }), 180000);
  assert.equal(lines.length, 0);
});
