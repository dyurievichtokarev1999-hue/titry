// PR #5 (QA и критик реализации, 10.11): ответ модели без строго булева safety_flag или с неверной формой
// не даёт ни черновика, ни заготовки, ни выдачи — только «проверка недоступна» с кодом bad_response.
// Рассказ вымышленный; модель, рендер и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft } from '../server/draft.js';
import { createBot, makeMetrics } from '../server/bot.js';

const STORY = 'Утром чай у окна. На столе раскрыта книга. Вечером шёл дождь.';
const modelReturning = (raw) => ({ beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(raw) }] }) } } });
const okRows = [{ role: 'Чай', value: 'у окна', source: 'Утром чай у окна' }, { role: 'Книга', value: 'раскрыта', source: 'На столе раскрыта книга' }, { role: 'Дождь', value: 'вечером', source: 'Вечером шёл дождь' }];
const base = { title: 'Чай и дождь', genre: 'камерное кино', mood: 'quiet', grammatical_gender: 'unknown', rows: okRows, post: { text: '', source: '' } };

const BAD = {
  'пустой объект': {},
  'null': null,
  'массив': [],
  'число': 0,
  'строка': '',
  'safety_flag: null': { ...base, safety_flag: null },
  'safety_flag: 0': { ...base, safety_flag: 0 },
  'safety_flag: ""': { ...base, safety_flag: '' },
  'safety_flag: "false"': { ...base, safety_flag: 'false' },
  'safety_flag: "true"': { ...base, safety_flag: 'true' },
  'safety_flag: 1': { ...base, safety_flag: 1 },
  'safety_flag отсутствует': (({ ...o }) => o)(base),
  'rows не массив': { ...base, safety_flag: false, rows: 'Чай' },
  'rows отсутствует при false': (({ rows, ...o }) => ({ ...o, safety_flag: false }))(base),
  'строка rows — массив': { ...base, safety_flag: false, rows: [['Чай', 'у окна']] },
};

for (const [name, raw] of Object.entries(BAD)) {
  test(`makeDraft: ${name} → unavailable, bad_response, без черновика`, async () => {
    const r = await makeDraft(STORY, { provider: 'claude', client: modelReturning(raw) });
    assert.equal(r.unavailable, true);
    assert.equal(r.code, 'bad_response');
    assert.equal(r.episode, null);
  });
}

test('бот: каждая неверная форма — без кнопки, render и sendVideo вызваны 0 раз', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [name, raw] of Object.entries(BAD)) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-pr5-'));
    let renders = 0, videos = 0;
    const sent = [];
    const tg = { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, sendVideo: async () => { videos++; } };
    const bot = createBot({ safetyCheck: async () => false,
      tg, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'pr5-salt'),
      draft: (story, o) => makeDraft(story, { ...o, provider: 'claude', client: modelReturning(raw) }),
      render: async () => { renders++; return {}; },
    });
    try {
      const chat = { id: 775500, type: 'private' };
      await bot.handleUpdate({ message: { chat, text: STORY } });
      assert.ok(!sent.some((m) => m.extra?.reply_markup), `${name}: кнопок нет`);
      await bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } });
      assert.equal(renders, 0, name);
      assert.equal(videos, 0, name);
      assert.ok(sent.some((m) => /^Ролик задерживается/.test(m.text)), `${name}: сообщение о задержке`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('контроли: true → остановка; явный false с опорами → черновик; сетевой сбой → unavailable', async () => {
  const stop = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ ...base, safety_flag: true }) });
  assert.equal(stop.episode, null);
  assert.equal(stop.risk.level, 'urgent');
  assert.notEqual(stop.unavailable, true);
  const stopNoRows = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ safety_flag: true }) });
  assert.equal(stopNoRows.risk.level, 'urgent', 'при true строки не нужны');
  const ok = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ ...base, safety_flag: false }) });
  assert.ok(ok.episode && ok.validation.ok);
  const net = await makeDraft(STORY, { provider: 'claude', client: { beta: { messages: { create: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } } } } });
  assert.equal(net.unavailable, true);
  assert.equal(net.code, 'ETIMEDOUT');
});
