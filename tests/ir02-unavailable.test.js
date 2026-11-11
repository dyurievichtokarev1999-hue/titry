// ИР-02: если модель не ответила, её проверка безопасности не завершена — заготовки без ИИ нет,
// только состояние «проверка недоступна». Это не остановка: рассказ не запоминается как запрещённый.
// Рассказ вымышленный (examples/), модель и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft } from '../server/draft.js';
import { createBot, makeMetrics } from '../server/bot.js';
import { createApp } from '../server/app.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const failingClient = { beta: { messages: { create: async () => { throw Object.assign(new Error('сеть'), { code: 'ETIMEDOUT' }); } } } };
// Подставной ответ модели после восстановления: проверка проходит полностью (safety_flag: false), без сети.
const okClient = { beta: { messages: { create: async () => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({
    title: example.episode.title, genre: example.episode.genre, mood: example.episode.mood, grammatical_gender: 'unknown',
    safety_flag: false, rows: example.episode.rows.map(({ role, value, source }) => ({ role, value, source })),
    post: { text: example.episode.post?.text || '', source: example.episode.post?.source || '' },
  }) }],
}) } } };

test('ИР-02: makeDraft при отказе модели — unavailable, без черновика', async () => {
  const r = await makeDraft(example.story, { provider: 'claude', client: failingClient });
  assert.equal(r.unavailable, true);
  assert.equal(r.episode, null);
  assert.equal(r.code, 'ETIMEDOUT');
  assert.notEqual(r.risk.level, 'urgent', 'это не остановка');
});

test('ИР-02: бот — сообщение о задержке, без карточки помощи и без ролика; повтор после восстановления работает', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir02-'));
  const sent = [];
  let down = true, renders = 0;
  const tg = { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, sendVideo: async () => {} };
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'ir02-salt'),
    draft: (story, o) => makeDraft(story, { ...o, provider: 'claude', client: down ? failingClient : okClient }),
    render: async () => { renders++; return {}; },
  });
  const chat = { id: 771202, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: example.story } });
    assert.equal(sent.at(-1).text, 'Ролик задерживается: сервис не завершил проверку. Сейчас отправить его не получится. Ждать в чате и отвечать на это сообщение не нужно.');
    assert.ok(!sent.some((m) => m.extra?.reply_markup), 'ни черновика, ни кнопок');
    assert.ok(!sent.some((m) => /112|помощ/i.test(m.text)), 'карточка помощи не показывается по ложному основанию');
    assert.equal(bot.sessions.get(chat.id).stage, 'idle');
    assert.equal(renders, 0);
    down = false; // сервис восстановился: тот же рассказ проходит полную проверку заново
    await bot.handleUpdate({ message: { chat, text: example.story } });
    assert.ok(sent.at(-1).extra?.reply_markup, 'после восстановления — обычный черновик');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('ИР-02: монтажная — 503 с экраном «Проверку завершить не удалось»', async (t) => {
  t.mock.method(console, 'error', () => {});
  // Свободный порт: заняли и сразу закрыли — соединение будет отклонено, модель недоступна. Сеть наружу не нужна.
  const probe = (await import('node:net')).createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const saved = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  let server, dataDir;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${deadPort}`;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir02-app-'));
    server = createApp({ render: async () => { throw new Error('не должно вызываться'); }, dataDir, safetyCheck: async () => false });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: example.story, provider: 'claude' }) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.unavailable, true);
    assert.equal(body.error, 'Проверку завершить не удалось');
    assert.equal(body.episode, undefined);
  } finally {
    if (server) server.close();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_BASE_URL', saved.base]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
