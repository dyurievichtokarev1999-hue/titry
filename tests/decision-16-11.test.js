// Решение владельца кода 16.11, коммит 2: (б) правка — не граница, (в) «бьёт / избивает», (г) «мне угрожают»,
// нормализация латинских двойников. Только вымышленные рассказы; модель, рендер и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics, continuationLevel } from '../server/bot.js';
import { assessRisk, prepareHelp, STOP_SCREEN_TEXT, cyrillicLookalikes } from '../server/safety.js';
import { joinEdits, EDIT_SEP } from '../engine/episode.js';
import { modelLike } from './helpers/fake-model.js';

const helpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-1611-help-'));
const HELP_FILE = path.join(helpDir, 'help.json');
await fs.writeFile(HELP_FILE, JSON.stringify({
  region: 'RU',
  emergency: { label: 'Единый номер экстренных служб', phone: '112', verified: true },
  contacts: [{ label: 'Линия помощи (тестовая карточка)', phone: '8-800-000-00-00', hours: 'круглосуточно', verified: true }],
}));
prepareHelp(HELP_FILE);
test.after(() => fs.rm(helpDir, { recursive: true, force: true }));

const STORY = 'Утром я пила чай. Днём я мыла посуду. Отравлюсь шавермой.';

async function withBot(fn, { render } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-1611-'));
  const sent = []; const c = { video: 0, render: 0 };
  const tg = {
    send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; },
  };
  const bot = createBot({
    tg, checkRetryMs: 0, safetyCheck: async () => false, draft: modelLike,
    metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'test-salt-fictional-0001'),
    render: render || (async (ep, o) => { c.render++; await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; }),
  });
  const chat = { id: 716101, type: 'private' };
  let mid = 0;
  const say = (text) => bot.handleUpdate({ message: { chat, message_id: ++mid, text } });
  const editMsg = (message_id, text) => bot.handleUpdate({ edited_message: { chat, message_id, text } });
  const play = async () => {
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m, 'кнопка ролика есть');
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
  };
  const stopped = () => sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT));
  try { await fn({ say, editMsg, play, sent, c, stopped }); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// ── (б) Правка не граница ──────────────────────────────────────────────────────────────────────────────

test('(б) joinEdits не меняет регистр правки: строчная правка после бытовой формы — продолжение', () => {
  assert.equal(joinEdits(`Отравлюсь шавермой.${EDIT_SEP}а потом таблетками.`), 'Отравлюсь шавермой.\nа потом таблетками.');
  assert.equal(assessRisk(joinEdits(`Отравлюсь шавермой.${EDIT_SEP}а потом таблетками.`)).level, 'urgent');
  assert.equal(assessRisk(joinEdits(`Отравлюсь шавермой.${EDIT_SEP}Утром кофе.`)).level, 'none');
  assert.equal(continuationLevel('Отравлюсь шавермой.', 'а потом таблетками'), 'urgent');
  assert.equal(continuationLevel('Отравлюсь шавермой.', 'Ок, спасибо'), 'none');
});

test('(б) «Отравлюсь шавермой.» + следующее сообщение-правка «а потом таблетками» → остановка', async () => {
  await withBot(async ({ say, stopped, c }) => {
    await say(STORY);
    await say('после: а потом таблетками');
    assert.ok(stopped(), 'правка со строчной — продолжение бытовой формы');
    assert.equal(c.video, 0);
  });
  await withBot(async ({ say, stopped }) => {
    await say('Отравлюсь шавермой.');
    await say('а потом таблетками');
    assert.ok(stopped(), 'новое сообщение со строчной — тоже продолжение');
  });
});

test('(б) правка своего сообщения «Отравлюсь шавермой.» → «Отравлюсь шавермой! а потом таблетками» → остановка', async () => {
  await withBot(async ({ say, editMsg, stopped, play, c }) => {
    await say(STORY);
    await editMsg(1, 'Утром я пила чай. Днём я мыла посуду. Отравлюсь шавермой! а потом таблетками');
    assert.ok(stopped());
    assert.equal(c.video, 0);
  });
});

test('(б) правка своего сообщения на «Ок, спасибо» → ролик', async () => {
  await withBot(async ({ say, editMsg, stopped, play, c }) => {
    await say(STORY);
    await editMsg(1, 'Ок, спасибо');
    assert.ok(!stopped());
    await play();
    assert.equal(c.video, 1);
  });
});

test('(б) во время подготовки ролика: строчное продолжение бытовой формы → экран остановки', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const render = async (ep, o) => { await gate; await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; };
  await withBot(async ({ say, play, stopped, c }) => {
    await say(STORY);
    const p = play();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await say('а потом таблетками');
    release();
    await p;
    assert.ok(stopped());
    assert.equal(c.video, 0);
  }, { render });
});

// ── (в) «бьёт / избивает» ──────────────────────────────────────────────────────────────────────────────

test('(в) «бьёт / избивает + человек или местоимение» → urgent; игра, спорт, бытовые «бьёт» — нет', () => {
  for (const t of ['Отчим бьёт маму.', 'Он избивает её.', 'Он бьёт её.', 'Маму бьёт отчим.']) assert.equal(assessRisk(t).level, 'urgent', t);
  for (const t of ['Он бьёт рекорды.', 'Часы бьют полночь.', 'Брат бьёт по мячу.']) assert.equal(assessRisk(t).level, 'none', t);
  for (const t of ['Брат бьёт брата в боксе.', 'Он бьёт его в шахматы.']) assert.notEqual(assessRisk(t).level, 'urgent', t);
});

// ── (г) «Мне угрожают / угрожали» ──────────────────────────────────────────────────────────────────────

test('(г) «мне угрожают» — urgent; ненасильственное дополнение в конце предложения — none; продолжение и орудие — urgent', () => {
  for (const t of ['Мне угрожают.', 'Мне угрожали.', 'Угрожают мне.', 'Мне угрожают ножом.', 'Мне угрожали полицией.',
    'Мне угрожали увольнением, а потом ножом.', 'Мне угрожали увольнением — и не только.', 'Мне угрожали увольнением и ножом.'])
    assert.equal(assessRisk(t).level, 'urgent', t);
  for (const t of ['Мне угрожали увольнением.', 'Мне угрожают штрафом.', 'Мне угрожали судом', 'Мне угрожали выговором!',
    'Мне угрожали отчислением.', 'Мне угрожали разводом.', 'Муж угрожает мне разводом.'])
    assert.equal(assessRisk(t).level, 'none', t);
});

// ── Нормализация ───────────────────────────────────────────────────────────────────────────────────────

test('нормализация: латинские двойники в русском слове → кириллица («пoрежусь» с латинской o → urgent)', () => {
  assert.equal(cyrillicLookalikes('пoрежусь'), 'порежусь');
  assert.equal(assessRisk('пoрежусь').level, 'urgent');
  assert.equal(assessRisk('Пoрежусь.').level, 'urgent');
  assert.equal(cyrillicLookalikes('iPhone сел'), 'iPhone сел', 'английские слова не трогаются');
  assert.equal(assessRisk('Без кофе мне не жить. iPhone сел.').level, 'none');
});
