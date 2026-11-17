// G0-fixes: ИР-04 — один рендер идёт, до трёх ждут, дальше «занято»; mood → quiet для пустого и неизвестного.
// Рассказ вымышленный (examples/), Telegram подставной.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics, MAX_RENDER_WAITING } from '../server/bot.js';
import { sanitizeEpisode } from '../engine/episode.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));

test('ИР-04: при полной очереди пятый запрос получает «занято», черновик сохраняется, позже рендер проходит', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir04-'));
  const sent = new Map();
  const tg = {
    send: async (id, text, extra) => { if (!sent.has(id)) sent.set(id, []); sent.get(id).push({ text, extra }); },
    action: async () => {}, answer: async () => {}, sendVideo: async (id) => { sent.get(id).push({ text: 'VIDEO' }); },
  };
  let release;
  const gate = new Promise((r) => { release = r; });
  let renders = 0;
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'ir04-salt'),
    draft: async () => ({ episode: structuredClone(example.episode), risk: { level: 'none' }, provider: 'ir04-fake', dropped: [] }),
    render: async (ep, o) => { renders++; await gate; return { outPath: o.outPath, seconds: 1, duration: 24 }; },
  });
  const users = [1, 2, 3, 4, 5].map((n) => ({ id: 880000 + n, type: 'private' }));
  const playOf = (chat) => sent.get(chat.id).findLast((x) => x.extra?.reply_markup?.inline_keyboard)?.extra.reply_markup.inline_keyboard[0][0].callback_data;
  try {
    for (const chat of users) await bot.handleUpdate({ message: { chat, text: example.story } });
    const jobs = users.slice(0, 1 + MAX_RENDER_WAITING).map((chat) => bot.handleUpdate({ callback_query: { id: 'q', data: playOf(chat), message: { chat } } }));
    await new Promise((r) => setImmediate(r));
    const fifth = users[4];
    await bot.handleUpdate({ callback_query: { id: 'q', data: playOf(fifth), message: { chat: fifth } } });
    assert.equal(sent.get(fifth.id).at(-1).text, "Сейчас очередь заполнена. Черновик остаётся здесь. Нажми «▶ Смотреть титры» ещё раз чуть позже.");
    assert.equal(bot.sessions.get(fifth.id).stage, 'draft', 'черновик сохранён');
    release();
    await Promise.all(jobs);
    assert.equal(renders, 4);
    for (const chat of users.slice(0, 4)) assert.equal(sent.get(chat.id).at(-1).text, 'VIDEO');
    await bot.handleUpdate({ callback_query: { id: 'q', data: playOf(fifth), message: { chat: fifth } } });
    assert.equal(renders, 5, 'после освобождения очереди пятый ролик собирается');
  } finally { release(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('mood: пустой или неизвестный — quiet; известный сохраняется', () => {
  assert.equal(sanitizeEpisode({ ...example.episode, mood: undefined, music: undefined }).mood, 'quiet');
  assert.equal(sanitizeEpisode({ ...example.episode, mood: 'восторг', music: undefined }).mood, 'quiet');
  assert.equal(sanitizeEpisode({ ...example.episode, mood: '', music: undefined }).music, 'quiet');
  assert.equal(sanitizeEpisode({ ...example.episode, mood: 'sad', music: 'sad' }).mood, 'sad');
  assert.equal(sanitizeEpisode({ ...example.episode, mood: 'anger', music: 'none' }).music, 'none');
});

test('mood: пустой жанр берётся по итоговому mood, а не «тёплая драма»', () => {
  const ep = sanitizeEpisode({ title: 'x' });
  assert.equal(ep.mood, 'quiet');
  assert.equal(ep.genre, 'камерное кино');
  assert.equal(sanitizeEpisode({ ...example.episode, genre: 'своя драма' }).genre, 'своя драма');
});

test('ИР-04: места в очереди освобождаются после ошибки рендера и после /delete во время ожидания', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-ir04b-'));
  const sent = new Map();
  const tg = {
    send: async (id, text, extra) => { if (!sent.has(id)) sent.set(id, []); sent.get(id).push({ text, extra }); },
    action: async () => {}, answer: async () => {}, sendVideo: async (id) => { sent.get(id).push({ text: 'VIDEO' }); },
  };
  let release;
  let gate = new Promise((r) => { release = r; });
  let calls = 0;
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'ir04-salt'),
    draft: async () => ({ episode: structuredClone(example.episode), risk: { level: 'none' }, provider: 'ir04-fake', dropped: [] }),
    render: async (ep, o) => { calls++; await gate; if (calls === 1) throw new Error('подставной сбой'); return { outPath: o.outPath, seconds: 1, duration: 24 }; },
  });
  const users = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 881000 + n, type: 'private' }));
  const playOf = (chat) => sent.get(chat.id).findLast((x) => x.extra?.reply_markup?.inline_keyboard)?.extra.reply_markup.inline_keyboard[0][0].callback_data;
  const click = (chat) => bot.handleUpdate({ callback_query: { id: 'q', data: playOf(chat), message: { chat } } });
  try {
    for (const chat of users) await bot.handleUpdate({ message: { chat, text: example.story } });
    const jobs = users.slice(0, 4).map(click); // 1 идёт (упадёт), 3 ждут
    await new Promise((r) => setImmediate(r));
    await bot.handleUpdate({ message: { chat: users[2], text: '/delete' } }); // один из ждущих удалил данные
    await click(users[4]);
    assert.match(sent.get(users[4].id).at(-1).text, /очередь заполнена/, 'пока очередь полна — «занято»');
    release();
    await Promise.all(jobs);
    assert.ok(sent.get(users[0].id).some((x) => /Не получилось собрать ролик/.test(x.text)), 'сбой рендера сообщён');
    assert.ok(!sent.get(users[2].id).some((x) => x.text === 'VIDEO'), 'после /delete ролик не отправлен');
    // Все места свободны: новые запросы проходят без «занято».
    for (const chat of [users[4], users[5]]) await click(chat);
    for (const chat of [users[4], users[5]]) assert.equal(sent.get(chat.id).at(-1).text, 'VIDEO');
  } finally { release(); await fs.rm(dir, { recursive: true, force: true }); }
});

// Правка редактора 10.11: quiet в трёх местах — правило без ИИ, blankEpisode, строка mood в промпте.
test('mood: quiet по умолчанию в правиле без ИИ, blankEpisode и промпте; явное настроение сохраняется', async () => {
  const { draftRuleBased, SYSTEM_PROMPT } = await import('../server/draft.js');
  const { blankEpisode } = await import('../engine/episode.js');
  assert.equal(blankEpisode().mood, 'quiet');
  assert.equal(blankEpisode().music, 'quiet');
  assert.equal(draftRuleBased('Утром работа. Днём встреча. Вечером ужин и прогулка.', { date: '2026-11-10' }).episode.mood, 'quiet');
  assert.equal(draftRuleBased('Утром работа. Весь день была злость на соседа. Вечером ужин.', { date: '2026-11-10' }).episode.mood, 'anger');
  assert.equal(draftRuleBased('Утром работа. Было грустно весь вечер. Потом ужин.', { date: '2026-11-10' }).episode.mood, 'sad');
  assert.equal(sanitizeEpisode({ ...example.episode, mood: 'warm', music: 'none' }).music, 'none');
  assert.ok(!/warm для обычного дня/.test(SYSTEM_PROMPT), 'в промпте нет warm по умолчанию');
  assert.match(SYSTEM_PROMPT, /quiet как нейтральное оформление/);
});

test('mood: служебные имена объекта не считаются известным настроением', () => {
  for (const m of ['constructor', '__proto__', 'toString']) assert.equal(sanitizeEpisode({ ...example.episode, mood: m, music: m }).mood, 'quiet', m);
});
