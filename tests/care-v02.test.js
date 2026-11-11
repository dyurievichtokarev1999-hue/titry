// Регрессия по задаче координатора GPT от 7.11.2026 «Закрыть расхождения в бережности v0.2».
// Все рассказы вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateEpisode, sanitizeEpisode } from '../engine/episode.js';
import { makeDraft } from '../server/draft.js';
import { renderEpisode } from '../server/render.js';
import { createApp } from '../server/app.js';
import { createBot, makeMetrics } from '../server/bot.js';

const URGENT_STORY = 'Сегодня опять всё валится из рук. Я не хочу больше жить. Вечером позвонила сестра.';
const UNIQUE = 'фиолетовый жираф Аркадий';
const SAFE_STORY = `Сегодня на работе обсуждали ${UNIQUE}. Вечером позвонил друг. Потом был ужин и сериал.`;

const goodEpisode = () => sanitizeEpisode({
  date: '2026-11-07', title: 'Жираф и звонок', genre: 'тёплая драма', mood: 'warm', music: 'warm',
  rows: [
    { role: 'На работе', value: `обсуждали ${UNIQUE}`, source: `на работе обсуждали ${UNIQUE}` },
    { role: 'Друг', value: 'вечером позвонил', source: 'Вечером позвонил друг' },
  ],
  post: { text: 'Ужин и сериал.', source: 'был ужин и сериал' },
});

function claudeClient(payload) {
  return { beta: { messages: { create: async () => ({ model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify(payload) }] }) } } };
}

// ── 1. Остановка по опасным темам не обходится ───────────────────────────────

test('urgent останавливает черновик даже с continueAfterHelp', async () => {
  const r = await makeDraft(URGENT_STORY, { provider: 'manual', continueAfterHelp: true });
  assert.equal(r.episode, null);
  assert.equal(r.risk.level, 'urgent');
});

test('safety_flag модели останавливает черновик даже с continueAfterHelp', async () => {
  const client = claudeClient({
    title: 'День', genre: 'тихая драма', mood: 'sad', grammatical_gender: 'unknown', safety_flag: true,
    rows: [{ role: 'Друг', value: 'вечерний звонок', source: 'Вечером позвонил друг' }, { role: 'Ужин', value: 'был', source: 'был ужин и сериал' }],
    post: { text: '', source: '' },
  });
  const r = await makeDraft(SAFE_STORY, { provider: 'claude', client, continueAfterHelp: true });
  assert.equal(r.episode, null);
  assert.equal(r.risk.level, 'urgent');
  assert.equal(r.risk.byModel, true);
});

test('рендер сам отказывается, если рассказ или строки содержат опасные темы', async () => {
  await assert.rejects(renderEpisode(goodEpisode(), { story: SAFE_STORY + ' ' + URGENT_STORY }), /безопасност/);
  const ep = goodEpisode();
  ep.rows[1].value = 'не хочу больше жить';
  await assert.rejects(renderEpisode(ep, { story: SAFE_STORY }), /безопасност/);
});

// ── 2. Жёсткая проверка цитат ────────────────────────────────────────────────

test('строка без цитаты, ненайденная цитата и сцена после титров без опоры — ошибки', () => {
  const noSource = goodEpisode(); noSource.rows[0].source = '';
  assert.ok(validateEpisode(noSource, SAFE_STORY).errors.some((e) => e.path === 'rows.0.source'));

  const wrong = goodEpisode(); wrong.rows[0].source = 'выиграл в лотерею';
  assert.ok(validateEpisode(wrong, SAFE_STORY).errors.some((e) => e.path === 'rows.0.source'));

  const post = goodEpisode(); post.post.source = '';
  assert.ok(validateEpisode(post, SAFE_STORY).errors.some((e) => e.path === 'post.source'));
});

test('без исходного рассказа эпизод не проходит проверку и не рендерится', async () => {
  const v = validateEpisode(goodEpisode());
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.path === 'story'));
  await assert.rejects(renderEpisode(goodEpisode(), {}), /рассказ/);
});

test('корректные строки с цитатами проходят', () => {
  const v = validateEpisode(goodEpisode(), SAFE_STORY);
  assert.deepEqual(v.errors, []);
});

// ── Монтажная: обход через HTTP ──────────────────────────────────────────────

async function withApp(fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-app-'));
  const calls = [];
  const render = async (ep, opts) => { calls.push({ ep, opts }); return { seconds: 1, outPath: opts.outPath }; };
  // Отдельная проверка подставная (разрешает): здесь проверяется локальный фильтр и валидация.
  const server = createApp({ render, dataDir, safetyCheck: async () => false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try { await fn({ post, calls, dataDir }); } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('монтажная: /api/draft не обходит остановку флагом continueAfterHelp', async () => {
  await withApp(async ({ post }) => {
    const r = await (await post('/api/draft', { story: URGENT_STORY, provider: 'manual', continueAfterHelp: true })).json();
    assert.equal(r.episode, undefined);
    assert.equal(r.risk.level, 'urgent');
  });
});

test('монтажная: /api/render в обход интерфейса не вызывает рендерер', async () => {
  await withApp(async ({ post, calls }) => {
    const danger = await post('/api/render', { episode: goodEpisode(), story: URGENT_STORY + ' ' + SAFE_STORY });
    assert.ok(danger.status >= 400);
    const noStory = await post('/api/render', { episode: goodEpisode() });
    assert.ok(noStory.status >= 400);
    const noSource = goodEpisode(); noSource.rows[0].source = '';
    assert.ok((await post('/api/render', { episode: noSource, story: SAFE_STORY })).status >= 400);
    assert.equal(calls.length, 0, 'рендерер не вызывался');
    const ok = await post('/api/render', { episode: goodEpisode(), story: SAFE_STORY });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
  });
});

// ── 3. Журнал без текстов ────────────────────────────────────────────────────

test('журнал монтажной не содержит текста рассказа и цитат при любом keepStory', async () => {
  await withApp(async ({ post, dataDir }) => {
    for (const keepStory of [true, false]) {
      const res = await post('/api/log', {
        participant: 'p01', day: 1, consent: true, keepStory, story: SAFE_STORY,
        episode: goodEpisode(), draft: goodEpisode(), provider: 'manual',
        feedback: { reaction: 'fit', shared: true, edits: { changedRows: 1 }, requested: ['words'] },
        notes: `участник сказал: ${UNIQUE}`,
      });
      assert.equal(res.status, 200);
    }
    const dir = path.join(dataDir, 'concierge', 'p01');
    const files = await fs.readdir(dir);
    assert.equal(files.length, 2);
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      assert.ok(!text.includes('жираф'), 'нет уникальной фразы');
      assert.ok(!text.includes('позвонил друг'), 'нет цитат');
      assert.ok(!text.includes('вечером позвонил') && !text.includes('На работе'), 'нет текста строк');
      const rec = JSON.parse(text);
      assert.equal(rec.reaction, 'fit');
      assert.equal(rec.rows, 2);
      assert.equal(rec.changedRows, 1);
    }
  });
});

// ── Бот ──────────────────────────────────────────────────────────────────────

const playId = (tg) => {
  const kb = [...(tg.sent.extras || [])].reverse().find((e) => e && e.reply_markup && e.reply_markup.inline_keyboard);
  return kb.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
};

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    send: async (chat, text, extra) => { sent.push(text); sent.extras = sent.extras || []; sent.extras.push(extra); },
    action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''),
    sendVideo: async () => { sent.push('VIDEO'); },
  };
}

test('бот: «продолжить» после срабатывания фильтра не делает черновик', async () => {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-bot-'));
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render: async () => { throw new Error('не должно вызываться'); }, draft: (s, o) => makeDraft(s, { ...o, provider: 'manual' }) });
  const chat = { id: 5, type: 'private' };
  await bot.handleUpdate({ message: { chat, text: URGENT_STORY } });
  await bot.handleUpdate({ message: { chat, text: 'продолжить' } });
  assert.ok(!tg.sent.some((t) => /Похоже на твой день/.test(t)));
});

test('бот: правка от самого человека становится опорой; опасная правка не рендерится', async () => {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-bot-'));
  const rendered = [];
  const render = async (ep, opts) => { rendered.push({ ep, opts }); await fs.mkdir(path.dirname(opts.outPath), { recursive: true }); await fs.writeFile(opts.outPath, 'x'); return { outPath: opts.outPath, duration: 24, seconds: 1 }; };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render, draft: (s, o) => makeDraft(s, { ...o, provider: 'manual' }) });
  const chat = { id: 6, type: 'private' };
  await bot.handleUpdate({ message: { chat, text: SAFE_STORY } });
  // рассказ не от первого лица: заготовка строк не берёт (белый список формы фразы, решение 11.11) —
  // человек добавляет строки сам, их слова становятся опорой
  await bot.handleUpdate({ message: { chat, text: '+ Утром — я кормила жирафа' } });
  await bot.handleUpdate({ message: { chat, text: '+ Вечером — я звонила другу' } });
  await bot.handleUpdate({ callback_query: { id: 'a', data: `play:${playId(tg)}`, message: { chat } } });
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].ep.rows.some((r) => r.value === 'я кормила жирафа'));
  assert.ok(rendered[0].opts.story.includes('я кормила жирафа'), 'правка человека — часть опоры');

  await bot.handleUpdate({ message: { chat, text: '2: не хочу больше жить' } });
  await bot.handleUpdate({ callback_query: { id: 'b', data: `play:${playId(tg)}`, message: { chat } } });
  assert.equal(rendered.length, 1, 'второй рендер не запускался');
  assert.ok(tg.sent.some((t) => /Сейчас важнее не титры/.test(t)));
});
