// PR #5 (критик реализации и владелец, 10.11 11:05): разрешение — только из полного ответа модели
// (stop_reason end_turn, ровно один текстовый блок, строгий false). Обрезанный или неполный ответ —
// закрытый отказ на всех путях: makeDraft, бот, /api/render. Рассказ вымышленный; модель подставная.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft, modelSafetyCheck } from '../server/draft.js';
import { createBot, makeMetrics } from '../server/bot.js';
import { createApp } from '../server/app.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const STORY = 'Утром чай у окна. На столе раскрыта книга. Вечером шёл дождь.';
const rows = [{ role: 'Чай', value: 'у окна', source: 'Утром чай у окна' }, { role: 'Книга', value: 'раскрыта', source: 'На столе раскрыта книга' }, { role: 'Дождь', value: 'вечером', source: 'Вечером шёл дождь' }];
const draftJson = (flag) => JSON.stringify({ title: 'Чай и дождь', genre: 'камерное кино', mood: 'quiet', grammatical_gender: 'unknown', safety_flag: flag, rows, post: { text: '', source: '' } });
const client = (response) => ({ beta: { messages: { create: async () => response } } });
const text = (t) => ({ type: 'text', text: t });

// Неполные ответы с «разрешением» внутри — ни один не должен дать черновик или ролик.
const INCOMPLETE = (json) => ({
  'max_tokens + false': { stop_reason: 'max_tokens', content: [text(json(false))] },
  'stop_sequence + false': { stop_reason: 'stop_sequence', content: [text(json(false))] },
  'stop_reason отсутствует': { content: [text(json(false))] },
  'пустой content': { stop_reason: 'end_turn', content: [] },
  'два текстовых блока': { stop_reason: 'end_turn', content: [text(json(false)), text(json(false))] },
});

test('makeDraft: неполный ответ с false → unavailable, без черновика', async () => {
  for (const [name, resp] of Object.entries(INCOMPLETE(draftJson))) {
    const r = await makeDraft(STORY, { provider: 'claude', client: client(resp) });
    assert.equal(r.unavailable, true, name);
    assert.equal(r.episode, null, name);
  }
});

test('makeDraft: max_tokens + true → остановка (обрезанное «опасно» не ослабляется)', async () => {
  const r = await makeDraft(STORY, { provider: 'claude', client: client({ stop_reason: 'max_tokens', content: [text(draftJson(true))] }) });
  assert.equal(r.episode, null);
  assert.equal(r.risk.level, 'urgent');
});

test('makeDraft: контроль end_turn + false → черновик', async () => {
  const r = await makeDraft(STORY, { provider: 'claude', client: client({ stop_reason: 'end_turn', content: [text(draftJson(false))] }) });
  assert.ok(r.episode && r.validation.ok);
});

test('бот: неполные ответы и max_tokens+true — render и sendVideo 0 раз', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cases = { ...INCOMPLETE(draftJson), 'max_tokens + true': { stop_reason: 'max_tokens', content: [text(draftJson(true))] } };
  for (const [name, resp] of Object.entries(cases)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sr-'));
    let renders = 0, videos = 0;
    const sent = [];
    const tg = { send: async (id, txt, extra) => { sent.push({ text: txt, extra }); }, action: async () => {}, answer: async () => {}, sendVideo: async () => { videos++; } };
    const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'sr-salt'), draft: (s, o) => makeDraft(s, { ...o, provider: 'claude', client: client(resp) }), render: async () => { renders++; return {}; } });
    try {
      const chat = { id: 776600, type: 'private' };
      await bot.handleUpdate({ message: { chat, text: STORY } });
      assert.ok(!sent.some((m) => m.extra?.reply_markup?.inline_keyboard?.some((row) => row.some((b) => /^play:/.test(b.callback_data)))), `${name}: нет кнопки ролика`);
      await bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } });
      assert.equal(renders, 0, name);
      assert.equal(videos, 0, name);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

const safetyJson = (flag) => JSON.stringify({ safety_flag: flag });

// Контракт владельца 10.11 12:05 п. 3: неполная проверка — не «опасно», а «проверка не завершена» (исключение с кодом).
test('modelSafetyCheck: «нет риска» только из полного ответа со строгим false; неполный ответ — исключение', async () => {
  for (const [name, resp] of Object.entries(INCOMPLETE(safetyJson))) await assert.rejects(modelSafetyCheck('день', { client: client(resp) }), (e) => typeof e.code === 'string', name);
  assert.equal(await modelSafetyCheck('день', { client: client({ stop_reason: 'max_tokens', content: [text(safetyJson(true))] }) }), true);
  for (const v of ['"false"', '0', 'null']) await assert.rejects(modelSafetyCheck('день', { client: client({ stop_reason: 'end_turn', content: [text(`{"safety_flag":${v}}`)] }) }), { code: 'bad_response' }, v);
  await assert.rejects(modelSafetyCheck('день', { client: client({ stop_reason: 'end_turn', content: [text('[]')] }) }), { code: 'bad_response' });
  assert.equal(await modelSafetyCheck('день', { client: client({ stop_reason: 'end_turn', content: [text(safetyJson(false))] }) }), false, 'контроль');
});

test('/api/render: неполный ответ проверки — 503 без вызова render; true — 422; контроль end_turn+false — рендер', async () => {
  const cases = { ...INCOMPLETE(safetyJson), 'max_tokens + true': { stop_reason: 'max_tokens', content: [text(safetyJson(true))] }, 'контроль': { stop_reason: 'end_turn', content: [text(safetyJson(false))] } };
  for (const [name, resp] of Object.entries(cases)) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sr-app-'));
    let renders = 0;
    const server = createApp({ dataDir, render: async (ep, o) => { renders++; return { seconds: 1, outPath: o.outPath }; }, safetyCheck: (s) => modelSafetyCheck(s, { client: client(resp) }) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episode: example.episode, story: example.story }) });
      if (name === 'контроль') { assert.equal(res.status, 200, name); assert.equal(renders, 1, name); }
      else { assert.equal(res.status, name === 'max_tokens + true' ? 422 : 503, name); assert.equal(renders, 0, name); }
    } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
  }
});

test('обычная форма claude-opus-5-5: блоки thinking, затем один text — разрешение, без ложного «опасно»', async () => {
  const thinking = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'redacted_thinking', data: 'x' }];
  assert.equal(await modelSafetyCheck('день', { client: client({ stop_reason: 'end_turn', content: [...thinking, text(safetyJson(false))] }) }), false);
  const r = await makeDraft(STORY, { provider: 'claude', client: client({ stop_reason: 'end_turn', content: [...thinking, text(draftJson(false))] }) });
  assert.ok(r.episode && r.validation.ok);
});

test('text не строка, content не массив, refusal с текстом — закрытый отказ', async () => {
  const arr = { stop_reason: 'end_turn', content: [{ type: 'text', text: [safetyJson(false)] }] };
  await assert.rejects(modelSafetyCheck('день', { client: client(arr) }), { code: 'bad_response' });
  const arrDraft = { stop_reason: 'end_turn', content: [{ type: 'text', text: [draftJson(false)] }] };
  assert.equal((await makeDraft(STORY, { provider: 'claude', client: client(arrDraft) })).unavailable, true);
  await assert.rejects(modelSafetyCheck('день', { client: client({ stop_reason: 'end_turn', content: 'нет' }) }), { code: 'bad_response' });
  assert.equal((await makeDraft(STORY, { provider: 'claude', client: client({ stop_reason: 'end_turn', content: null }) })).unavailable, true);
  await assert.rejects(modelSafetyCheck('день', { client: client({ stop_reason: 'refusal', content: [text(safetyJson(false))] }) }), { code: 'refusal' });
  assert.equal((await makeDraft(STORY, { provider: 'claude', client: client({ stop_reason: 'refusal', content: [text(draftJson(false))] }) })).unavailable, true);
});
