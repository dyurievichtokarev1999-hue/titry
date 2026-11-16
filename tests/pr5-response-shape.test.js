// PR #5 (QA и критик реализации, 10.11): ответ модели без строго булева safety_flag или с неверной формой
// не даёт черновика модели и выдачи. С решения 16.11 (п. 1.1, заменяет ИР-02): после единственного повтора —
// заготовка из слов человека (нехватка с приглашением), а не «проверка недоступна».
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
  test(`makeDraft: ${name} → 2 попытки, заготовка (нехватка), без черновика модели`, async () => {
    let calls = 0;
    const c = modelReturning(raw); const create = c.beta.messages.create;
    c.beta.messages.create = async (...a) => { calls++; return create(...a); };
    const r = await makeDraft(STORY, { provider: 'claude', client: c, retryDelayMs: 0 });
    assert.equal(calls, 2, 'ровно один повтор');
    assert.notEqual(r.unavailable, true);
    assert.equal(r.insufficient, true);
    assert.equal(r.provider, 'manual');
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
      draft: (story, o) => makeDraft(story, { ...o, provider: 'claude', client: modelReturning(raw), retryDelayMs: 0 }),
      render: async () => { renders++; return {}; },
    });
    try {
      const chat = { id: 775500, type: 'private' };
      await bot.handleUpdate({ message: { chat, text: STORY } });
      assert.ok(!sent.some((m) => m.extra?.reply_markup), `${name}: кнопок нет`);
      await bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat } } });
      assert.equal(renders, 0, name);
      assert.equal(videos, 0, name);
      assert.ok(!sent.some((m) => /^Ролик задерживается/.test(m.text)), `${name}: «проверка недоступна» больше нет`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('контроли: true → черновик и concern в удержании; явный false → черновик; сетевой сбой → заготовка', async () => {
  const flagged = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ ...base, safety_flag: true }) });
  assert.ok(flagged.episode && flagged.validation.ok, 'флаг модели не останавливает (решение 16.11, п. 1.2)');
  assert.equal(flagged.modelConcern, true);
  assert.notEqual(flagged.risk.level, 'urgent');
  const flaggedNoRows = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ safety_flag: true }) });
  assert.equal(flaggedNoRows.modelConcern, true, 'при true без строк — заготовка и concern');
  assert.equal(flaggedNoRows.provider, 'manual');
  const ok = await makeDraft(STORY, { provider: 'claude', client: modelReturning({ ...base, safety_flag: false }) });
  assert.ok(ok.episode && ok.validation.ok);
  const net = await makeDraft(STORY, { provider: 'claude', retryDelayMs: 0, client: { beta: { messages: { create: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } } } } });
  assert.notEqual(net.unavailable, true);
  assert.equal(net.provider, 'manual');
});
