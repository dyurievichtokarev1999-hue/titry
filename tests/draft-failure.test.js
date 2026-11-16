// Решение владельца кода 16.11, коммит 1 (заменяет ИР-02, tests/ir02-unavailable.test.js):
//  1.1 сбой черновика — 30 с на попытку, maxRetries: 0, наш повтор ровно один; дальше заготовка из слов человека
//      и та же проверка перед рендером; заготовки нет — техническая реплика без контактов;
//  1.2 safety_flag черновика ничего не останавливает: concern в удержании, три исхода проверки перед рендером.
// Только вымышленные рассказы; модель, рендер и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft, makeModelClient, CLIENT_OPTIONS, MODEL_TIMEOUT_MS, SAFETY_TIMEOUT_MS } from '../server/draft.js';
import { createBot, makeMetrics, TEXT } from '../server/bot.js';
import { createApp } from '../server/app.js';
import { prepareHelp, TRY_LATER_TEXT, STOP_SCREEN_TEXT } from '../server/safety.js';
import { fakeModelClient } from './helpers/fake-model.js';

const helpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-df-help-'));
const HELP_FILE = path.join(helpDir, 'help.json');
await fs.writeFile(HELP_FILE, JSON.stringify({
  region: 'RU',
  emergency: { label: 'Единый номер экстренных служб', phone: '112', verified: true },
  contacts: [{ label: 'Линия помощи (тестовая карточка)', phone: '8-800-000-00-00', hours: 'круглосуточно', verified: true }],
}));
prepareHelp(HELP_FILE);
test.after(() => fs.rm(helpDir, { recursive: true, force: true }));

const STORY = 'Утром я пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.';
const failing = () => {
  const c = { calls: 0, beta: { messages: { create: async () => { c.calls++; throw Object.assign(new Error('сеть'), { code: 'ETIMEDOUT' }); } } } };
  return c;
};
// Модель ставит safety_flag: true, строки — как обычно (бытовой рассказ, ложное срабатывание модели).
const flagging = () => {
  const inner = fakeModelClient();
  const c = { calls: 0, beta: { messages: { create: async (req) => {
    c.calls++;
    const r = await inner.beta.messages.create(req);
    const raw = JSON.parse(r.content[0].text);
    return { ...r, content: [{ type: 'text', text: JSON.stringify({ ...raw, safety_flag: true }) }] };
  } } } };
  return c;
};

async function withBot({ client, check = async () => false, fallback }, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-df-'));
  const sent = []; const c = { render: 0, video: 0, check: 0 };
  const tg = {
    send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; },
  };
  const render = async (ep, o) => { c.render++; await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; };
  const bot = createBot({
    tg, render, checkRetryMs: 0, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'test-salt-fictional-0001'),
    safetyCheck: async (t) => { c.check++; return check(t); },
    draft: (st, o) => makeDraft(st, { ...o, provider: 'claude', client, retryDelayMs: 0, ...(fallback ? { fallback } : {}) }),
  });
  const chat = { id: 716001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const play = async () => {
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m, 'кнопка ролика есть');
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
  };
  try { await fn({ say, play, sent, c }); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('1.1: оба клиента — 30 с на попытку и maxRetries: 0', () => {
  assert.equal(MODEL_TIMEOUT_MS, 30_000);
  assert.equal(SAFETY_TIMEOUT_MS, 30_000);
  assert.deepEqual({ ...CLIENT_OPTIONS }, { timeout: 30_000, maxRetries: 0 });
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-dummy';
  try {
    const client = makeModelClient();
    assert.equal(client.timeout, 30_000);
    assert.equal(client.maxRetries, 0);
  } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
});

test('1.1: черновик и проверка перед рендером строят клиента только через makeModelClient', async () => {
  const src = await fs.readFile(new URL('../server/draft.js', import.meta.url), 'utf8');
  assert.equal((src.match(/new Anthropic\(/g) || []).length, 1, 'единственный конструктор клиента — в makeModelClient');
  assert.equal((src.match(/client \|\| makeModelClient\(\)/g) || []).length, 2, 'черновик и проверка перед рендером');
});

test('1.1: сбой черновика — ровно 2 вызова модели, затем заготовка', async () => {
  const client = failing();
  const r = await makeDraft(STORY, { provider: 'claude', client, retryDelayMs: 0 });
  assert.equal(client.calls, 2);
  assert.equal(r.provider, 'manual');
  assert.notEqual(r.unavailable, true);
});

test('1.1: заготовка → строки человека → 1 видео', async () => {
  const client = failing();
  await withBot({ client }, async ({ say, play, sent, c }) => {
    await say(STORY);
    assert.equal(client.calls, 2);
    assert.ok(!sent.some((m) => /задерживается/.test(m.text)), 'нет «проверка недоступна»');
    await say('+ Утром — пила чай');
    await say('+ Днём — мыла посуду');
    await play();
    assert.equal(c.check, 1, 'та же проверка перед рендером');
    assert.equal(c.video, 1);
  });
});

test('1.1: заготовки нет → 0 видео и ровно одна техническая реплика без контактов', async () => {
  const client = failing();
  await withBot({ client, fallback: () => { throw new Error('заготовка не собирается'); } }, async ({ say, sent, c }) => {
    await say(STORY);
    const replies = sent.filter((m) => m.text === TEXT.renderFail);
    assert.equal(replies.length, 1);
    assert.equal(sent.at(-1).text, TEXT.renderFail);
    assert.ok(!sent.some((m) => /112|8-800|Линия помощи/.test(m.text)), 'без контактов');
    assert.ok(!sent.some((m) => m.text.startsWith(TRY_LATER_TEXT)), 'не TRY_LATER');
    assert.equal(c.render, 0); assert.equal(c.video, 0);
  });
});

test('1.2: safety_flag черновика не останавливает и вызова не порождает; безопасно → ролик', async () => {
  const client = flagging();
  await withBot({ client, check: async () => false }, async ({ say, play, sent, c }) => {
    await say(STORY);
    assert.equal(client.calls, 1, 'флаг не порождает повторного вызова');
    assert.ok(!sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)), 'остановки нет');
    await play();
    assert.equal(c.check, 1);
    assert.equal(c.video, 1);
  });
});

test('1.2: safety_flag + проверка «опасно» → экран остановки, 0 видео', async () => {
  await withBot({ client: flagging(), check: async () => true }, async ({ say, play, sent, c }) => {
    await say(STORY);
    await play();
    assert.ok(sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)));
    assert.equal(c.video, 0);
  });
});

test('1.2: safety_flag + «неизвестно» → 0 видео, ровно одно сообщение TRY_LATER_TEXT с контактами', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withBot({ client: flagging(), check: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); } }, async ({ say, play, sent, c }) => {
    await say(STORY);
    const before = sent.length;
    await play();
    const after = sent.slice(before).filter((m) => !/^Собираю|^Проверяю|очереди/.test(m.text));
    const tl = after.filter((m) => m.text.startsWith(TRY_LATER_TEXT));
    assert.equal(tl.length, 1);
    assert.match(tl[0].text, /8-800-000-00-00/);
    assert.ok(!sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)), 'не экран остановки');
    assert.equal(c.check, 2, 'проверка и её единственный повтор');
    assert.equal(c.video, 0);
  });
});

test('1.2 монтажная: safety_flag + «неизвестно» → 503 TRY_LATER с контактами; без флага — рендер', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const flagged of [true, false]) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-df-app-'));
    let renders = 0;
    const client = flagged ? flagging() : fakeModelClient();
    const server = createApp({
      dataDir, checkRetryMs: 0,
      draft: (st, o) => makeDraft(st, { ...o, provider: 'claude', client }),
      safetyCheck: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); },
      render: async (ep, o) => { renders++; return { seconds: 1, outPath: o.outPath }; },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
    const post = (p, b) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    try {
      const d = await (await post('/api/draft', { story: STORY })).json();
      assert.ok(d.episode, 'черновик есть');
      const res = await post('/api/render', { episode: d.episode, story: STORY });
      if (flagged) {
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error, TRY_LATER_TEXT);
        assert.match(body.help, /8-800-000-00-00/);
        assert.equal(renders, 0);
      } else {
        assert.equal(res.status, 200);
      }
    } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
  }
});

test('1.1 монтажная: сбой модели → заготовка (нехватка, 422), заготовки нет → существующая техническая реплика 500 без контактов', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const noFallback of [false, true]) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-df-app2-'));
    const client = failing();
    const server = createApp({
      dataDir, safetyCheck: async () => false, render: async () => { throw new Error('не должно вызываться'); },
      draft: (st, o) => makeDraft(st, { ...o, provider: 'claude', client, retryDelayMs: 0, ...(noFallback ? { fallback: () => { throw new Error('нет'); } } : {}) }),
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: STORY }) });
      const body = await res.json();
      assert.equal(client.calls, 2);
      if (noFallback) {
        assert.equal(res.status, 500);
        assert.match(body.error, /^Ошибка сервера \([a-z_A-Z]+\)\. Попробуйте ещё раз\.$/);
        assert.ok(!JSON.stringify(body).includes('112') && !body.help, 'без контактов');
        assert.notEqual(body.error, TRY_LATER_TEXT);
      } else {
        assert.equal(res.status, 422);
        assert.equal(body.kind, 'insufficient');
      }
    } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
  }
});
