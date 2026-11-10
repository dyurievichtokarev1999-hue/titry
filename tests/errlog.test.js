// ИР-03: журнал ошибок обезличен на пяти путях (черновик, рендер, распознавание, обработка обновления, монтажная).
// Исключения нарочно содержат маркер и текст вымышленного рассказа; в журнал не должно попасть ни то, ни другое.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics } from '../server/bot.js';
import { createApp } from '../server/app.js';
import { safeCode } from '../server/errlog.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const MARKER = 'МАРКЕР-ИР03-не-в-журнал';
const leaky = (code) => Object.assign(new Error(`${MARKER}: ${example.story}`), code ? { code } : {});
const chat = { id: 553311, type: 'private' };

function capture(t) {
  const calls = t.mock.method(console, 'error', () => {});
  return () => calls.mock.calls.map((c) => c.arguments.map(String).join(' '));
}
function assertClean(lines, stage) {
  assert.ok(lines.length > 0, `ошибка на этапе ${stage} записана`);
  for (const l of lines) {
    assert.ok(!l.includes(MARKER), `маркер не в журнале: ${stage}`);
    assert.ok(!l.includes(example.story.slice(0, 20)), `текст рассказа не в журнале: ${stage}`);
    assert.ok(!l.includes(String(chat.id)), `id чата не в журнале: ${stage}`);
  }
  const rec = JSON.parse(lines.find((l) => l.includes(`"stage":"${stage}"`)));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'code', 'level', 'stage', 'version']);
}

async function makeBot(overrides) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir03-'));
  const sent = [];
  const tg = { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, sendVideo: async () => {}, fileBuffer: async () => Buffer.from('ogg'), ...overrides.tg };
  const bot = createBot({
    tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'ir03-salt'),
    draft: async () => ({ episode: structuredClone(example.episode), risk: { level: 'none' }, provider: 'ir03-fake', dropped: [] }),
    render: async (ep, o) => ({ outPath: o.outPath, seconds: 1, duration: 24 }),
    ...overrides, tg,
  });
  return { bot, sent, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('ИР-03: черновик', async (t) => {
  const lines = capture(t);
  const { bot, cleanup } = await makeBot({ tg: {}, draft: async () => { throw leaky(); } });
  try { await bot.handleUpdate({ message: { chat, text: example.story } }); assertClean(lines(), 'draft'); } finally { await cleanup(); }
});

test('ИР-03: рендер', async (t) => {
  const lines = capture(t);
  const { bot, sent, cleanup } = await makeBot({ tg: {}, render: async () => { throw leaky('ENOSPC'); } });
  try {
    await bot.handleUpdate({ message: { chat, text: example.story } });
    const play = sent.findLast((x) => x.extra?.reply_markup?.inline_keyboard)?.extra.reply_markup.inline_keyboard[0][0].callback_data;
    await bot.handleUpdate({ callback_query: { id: 'q', data: play, message: { chat } } });
    assertClean(lines(), 'render');
    assert.ok(lines().some((l) => l.includes('"code":"ENOSPC"')));
  } finally { await cleanup(); }
});

test('ИР-03: распознавание речи', async (t) => {
  const lines = capture(t);
  const { bot, cleanup } = await makeBot({ tg: {}, transcribe: async () => { throw leaky(); } });
  try { await bot.handleUpdate({ message: { chat, voice: { duration: 5, file_id: 'f' } } }); assertClean(lines(), 'stt'); } finally { await cleanup(); }
});

test('ИР-03: обработка обновления', async (t) => {
  const lines = capture(t);
  const { bot, cleanup } = await makeBot({ tg: { send: async () => { throw leaky(); } } });
  try { await bot.handleUpdate({ message: { chat, text: '/start' } }); assertClean(lines(), 'update'); } finally { await cleanup(); }
});

test('ИР-03: монтажная', async (t) => {
  const lines = capture(t);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir03-app-'));
  const server = createApp({ render: async () => { throw leaky(); }, dataDir, safetyCheck: async () => false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episode: example.episode, story: example.story }) });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes(MARKER), 'клиенту монтажной не уходит сообщение исключения');
    assertClean(lines(), 'http POST /api/render');
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('ИР-03: код ошибки — только короткий идентификатор', () => {
  assert.equal(safeCode({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(safeCode({ status: 429 }), '429');
  assert.equal(safeCode(new TypeError('x')), 'TypeError');
  assert.equal(safeCode({ code: `${MARKER} длинный текст` }), 'error');
  assert.equal(safeCode(null), 'error');
});
