// Решение владельца кода 16.11, коммит 2: (б) правка — не граница, (в) «бьёт / избивает», (г) «мне угрожают»,
// нормализация латинских двойников. Только вымышленные рассказы; модель, рендер и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, makeMetrics, continuationLevel } from '../server/bot.js';
import { assessRisk, prepareHelp, STOP_SCREEN_TEXT, TRY_LATER_TEXT, cyrillicLookalikes } from '../server/safety.js';
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

test('(б) joinEdits не меняет регистр правки; правка — с союза и эллиптическая — продолжение', () => {
  assert.equal(joinEdits(`Отравлюсь шавермой.${EDIT_SEP}а потом таблетками.`), 'Отравлюсь шавермой.\n\u2029а потом таблетками.');
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

// ── Разбор дельты 1b517c26..bedb952 ────────────────────────────────────────────────────────────────────

test('разбор: безобидное дополнение не снимает более раннюю угрозу; эмодзи и скобка после списка — none', () => {
  for (const t of ['Мне угрожают расправой, а начальник мне угрожает увольнением.', 'Мне угрожают, а начальник угрожает мне увольнением.',
    'Бывший мне угрожает, а банк мне угрожает судом.', 'Мне угрожал бывший муж, мне угрожали увольнением.', 'Мне угрожают по ночам, и ещё мне угрожают судом.'])
    assert.equal(assessRisk(t).level, 'urgent', t);
  for (const t of ['Мне угрожали выговором 😅', 'Мне угрожали увольнением)', 'Начальник мне угрожает увольнением.']) assert.equal(assessRisk(t).level, 'none', t);
});

test('разбор: «бьёт дрожь / током / в шутку» — не насилие; «хочу сдохнуть от смеха» — urgent', () => {
  for (const t of ['Её бьёт дрожь.', 'Его бьёт озноб.', 'Брата бьёт мандраж перед экзаменом.', 'Нас бьёт током от двери.',
    'Она бьёт его по плечу в шутку.', 'Он бьёт сестру шутя.', 'Дед бьёт меня по плечу.']) assert.notEqual(assessRisk(t).level, 'urgent', t);
  for (const t of ['Он бьёт её по плечу и по лицу.', 'Муж бьёт жену в шутку кулаком.', 'Он бьёт её током.', 'Отчим бьёт меня током.',
    'Сестра избила брата в настольный теннис.', 'Хочу просто сдохнуть.', 'Муж с ножом мне угрожает разводом.']) assert.equal(assessRisk(t).level, 'urgent', t);
  assert.equal(assessRisk('Сегодня начальник опять мне угрожал увольнением.').level, 'none');
  for (const t of ['Хочу сдохнуть от смеха.', 'Хочу сдохнуть со стыда.']) assert.equal(assessRisk(t).level, 'urgent', t);
  assert.notEqual(assessRisk('Умру со смеху.').level, 'urgent');
});

test('разбор: короткие «ок / спасибо / да» после бытовой формы — ответ, а не продолжение', async () => {
  assert.equal(continuationLevel('Отравлюсь шавермой.', 'спасибо'), 'none');
  assert.equal(continuationLevel('Отравлюсь шавермой.', 'ок 🙂'), 'none');
  assert.equal(continuationLevel('Отравлюсь шавермой.', 'и ядом'), 'urgent');
  await withBot(async ({ say, stopped }) => {
    await say('Утром я пила чай. Днём я мыла посуду. Отравлюсь шавермой.');
    await say('спасибо');
    await say('ок');
    assert.ok(!stopped());
  });
});

// ── Уточнение 16.11 (разбор 8f5726cc): продолжение — союз, а не регистр ────────────────────────────────

test('уточнение (б): после «Отравлюсь шавермой.» обычные сообщения — ролик, не продолжение', async () => {
  for (const next of ['ну и день был', 'да, было весело', 'кстати, вечером смотрели кино', 'Ок, спасибо']) {
    assert.equal(continuationLevel('Отравлюсь шавермой.', next), 'none', next);
    await withBot(async ({ say, play, stopped, c }) => {
      await say(STORY);
      await say(next);
      assert.ok(!stopped(), next);
    });
  }
  await withBot(async ({ say, play, stopped, c }) => {
    await say(STORY);
    await say('ну и день был');
    assert.ok(!stopped());
  });
});

test('уточнение (б), разбор f0d9ff1: невидимые символы и эмодзи-клавиша перед союзом не обходят правило; скобка и эмодзи посреди фразы — не конец', () => {
  for (const t of ['Отравлюсь шавермой.\n\u200bи таблетками', 'Отравлюсь шавермой.\n\u2060и таблетками', 'Отравлюсь шавермой.\n\u00adи таблетками',
    'Отравлюсь шавермой.\n#\ufe0f\u20e3 и таблетками', 'Отравлюсь шавермой.\n1\ufe0f\u20e3 и таблетками',
    'Отравлюсь шавермой) таблетками', 'Отравлюсь шавермой» таблетками', 'Отравлюсь шавермой 😅 таблетками']) assert.equal(assessRisk(t).level, 'urgent', JSON.stringify(t));
  assert.equal(continuationLevel('Отравлюсь шавермой.', '\u200bи таблетками'), 'urgent');
  for (const t of ['Отравлюсь шавермой :)', 'Отравлюсь шавермой 😅', 'Отравлюсь шавермой)))', '(отравлюсь шавермой)', 'Отравлюсь шавермой :) Утром кофе', 'Отравлюсь шавермой! ))'])
    assert.equal(assessRisk(t).level, 'none', JSON.stringify(t));
});

test('уточнение (б), разбор e5bdec2: голый пробел перед заглавной или цифрой — не конец формы; пустые буквы хангыль перед союзом', () => {
  for (const t of ['Отравлюсь шавермой 20 таблеток выпью', 'Отравлюсь шавермой 2 таблетками', 'Отравлюсь шавермой Таблетками',
    'Мне не жить без кофе Без тебя', 'Без кофе мне не жить Совсем', 'Отравлюсь шавермой.\n\u3164и таблетками', 'Отравлюсь шавермой.\n\u115fи таблетками'])
    assert.equal(assessRisk(t).level, 'urgent', JSON.stringify(t));
});

test('разбор a558708: невидимые символы вырезаются до фильтра — не разрывают слово и не изображают конец формы', () => {
  for (const t of ['Отравлюсь шавермой\u200b 20 таблеток выпью', 'Отравлюсь шавермой\u200bТаблетками', 'Отравлюсь шавермой \u2060 Таблетками',
    'Отравлюсь шавермой\u00ad 20 таблеток', 'Отравлюсь шавермой\ufe0f Таблетками', 'Отравлюсь шавермой\u200d 2 таблетками',
    'Мне не жить без кофе\u200b Без тебя', 'Отрав\u200bлюсь', 'Хочу\u200bумереть', 'убью\u200bсебя', 'я по\u00adрежусь']) assert.equal(assessRisk(t).level, 'urgent', JSON.stringify(t));
  for (const t of ['Отравлюсь шавермой ❤️', 'Отравлюсь шавермой 👨‍👩‍👧 Утром кофе']) assert.equal(assessRisk(t).level, 'none', JSON.stringify(t));
});

// ── Уточнение после сверки 3b48cf06: эллиптическое продолжение ────────────────────────────────────────

test('эллиптическое продолжение: полная фраза с глаголом и обычные реплики — ролик', async () => {
  for (const next of ['а потом пошли в кино', 'и было вкусно', 'и мама смеялась', 'А потом мы пошли домой.', 'Ок, спасибо', 'ну и день был'])
    assert.equal(continuationLevel('Утром я пила чай. Отравлюсь шавермой.', next), 'none', next);
  for (const t of ['Отравлюсь шавермой! А потом в кино.', 'Без кофе мне не жить! А на работе завал.', 'Без кофе мне не жить. И пошла варить.'])
    assert.equal(assessRisk(t).level, 'none', t);
  await withBot(async ({ say, play, stopped, c }) => {
    await say(STORY);
    await say('а потом пошли в кино');
    await say('название: вечер');
    assert.ok(!stopped());
  });
});

// ── Решение владельца кода 16.11, вариант (б): правило продолжения заморожено ─────────────────────────────

test('вариант (б), обязательное: тревожный обрывок — concern; обычная речь — ролик; однозначный способ — остановка', () => {
  const P = 'Утром я пила чай. Отравлюсь шавермой.';
  for (const n of ['и уснуть', 'и пусть плачут', 'и хватит', 'и всё, что было']) assert.equal(continuationLevel(P, n), 'concern', n);
  for (const n of ['а потом газету', 'и колесо обозрения', 'и чёрт с ним', 'и жизнь прекрасна', 'Таблетки от головы', 'Таблетку бы',
    'и мама смеялась', 'а потом пошли в кино', 'Ок, спасибо', 'хаха 😂']) assert.equal(continuationLevel(P, n), 'none', n);
  for (const n of ['и таблетками', 'а потом таблетками.', 'a потом таблетками', 'затем с крыши', 'таблетками', 'затем ножом', 'а потом с крыши',
    '— и таблетками', '🙂 и таблетками', 'А потом таблетками.']) assert.equal(continuationLevel(P, n), 'urgent', n);
});

test('вариант (б): опасные обрывки прошлых разборов не дают none (urgent или concern — решает модель)', () => {
  const P = 'Утром я пила чай. Отравлюсь шавермой.';
  for (const n of ['и ядом', 'и в петлю', 'А потом в окно.', 'и таблетки', 'и 20 таблеток', 'и вены', 'и пистолет', 'и вниз', 'и насмерть',
    'и всё, конец', 'и прощай', 'и в петлю полезу', 'и вены вскрою', 'и в воду', 'и на тот свет', 'и в омут', 'и ко дну', 'и шприцем',
    'и уснуть и не проснуться', 'и меня не будет', 'и никто не заметит', 'и всем будет легче', 'и выпить всё что есть в аптечке',
    'и в окно вышла', 'и газом надышалась', 'и под поезд бросилась', 'и в последний путь', 'и насовсем', 'С крыши', 'Ядом'])
    assert.notEqual(continuationLevel(P, n), 'none', n);
  assert.notEqual(assessRisk('Без кофе мне не жить. И без тебя тоже.').level, 'none');
});

test('вариант (б): тревожный обрывок отдельным сообщением — concern в рассказе; без ключа API — по решению 13.11 (ролик и блок помощи)', async () => {
  const sent = []; let videos = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-b-nokey-'));
  const bot = createBot({
    tg: { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { videos++; } },
    hasKey: () => false, draft: modelLike, metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'test-salt-fictional-0001'),
    render: async (ep, o) => { await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; },
  });
  const chat = { id: 716211, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: 'Утром я пила чай. Днём я мыла посуду. Отравлюсь шавермой.' } });
    await bot.handleUpdate({ message: { chat, text: 'и хватит' } });
    assert.ok(!sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)), 'не остановка');
    assert.ok(sent.some((m) => /8-800-000-00-00/.test(m.text)), 'concern: блок помощи с контактами');
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m, 'черновик есть');
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
    assert.equal(videos, 1, 'без ключа — только локальный фильтр, concern не мешает ролику (условие 4 решения 13.11)');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('вариант (б): тревожный обрывок + модель «неизвестно» → 0 видео, TRY_LATER и контакты (решение 13.11, условие 3)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const sent = []; let videos = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-b-unk-'));
  const bot = createBot({
    tg: { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { videos++; } },
    checkRetryMs: 0, safetyCheck: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); }, draft: modelLike,
    metrics: makeMetrics(path.join(dir, 'm.jsonl'), 'test-salt-fictional-0001'),
    render: async (ep, o) => { await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; },
  });
  const chat = { id: 716212, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: 'Утром я пила чай. Днём я мыла посуду. Отравлюсь шавермой. И хватит.' } });
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m);
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
    assert.equal(videos, 0);
    assert.ok(sent.some((x) => x.text.startsWith(TRY_LATER_TEXT) && /8-800-000-00-00/.test(x.text)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('вариант (б), финальный разбор 1cc92f7: знак после союза, формы словаря, «Убить готова за кофе!» + способ, «либо» — остановка', () => {
  const forms = ['Отравлюсь шавермой.', 'Без кофе мне не жить.', 'Убить готова за кофе!', 'Мне не жить без кофе.'];
  const tails = ['и... таблетками', 'И… таблетками', 'а потом... с крыши', 'и ножиком', 'и вешаться', 'и с высотки', 'и передоз', 'и меня нет', 'и под машину', 'либо таблетками'];
  for (const f of forms) {
    for (const d of tails) {
      assert.equal(assessRisk(`${f} ${d}`).level, 'urgent', `${f} ${d}`);
      assert.equal(continuationLevel(`Утром чай. ${f}`, d), 'urgent', `${f} + ${d}`);
    }
    for (const d of ['таблетками', 'с крыши', 'ножиком', 'под поезд']) assert.equal(assessRisk(`${f}\n${d}`).level, 'urgent', `${f}\\n${d}`);
  }
  // Сама форма и обычное продолжение — без изменений.
  assert.equal(assessRisk('Убить готова за кофе!').level, 'none');
  assert.equal(assessRisk('Убить готова за кофе! Утром дождь.').level, 'none');
  assert.equal(assessRisk('Отравлюсь шавермой! А потом в кино.').level, 'none');
});

test('вариант (б), доделка разбора 59e8ab0: составные союзы со знаком и без; склейка не срабатывает зря; поле эпизода; «в окно» отдельной строкой', () => {
  const forms = ['Отравлюсь шавермой.', 'Без кофе мне не жить.', 'Убить готова за кофе!', 'Мне не жить без кофе.'];
  const conj = ['и потом', 'а потом', 'и затем', 'и ещё', 'ну и', 'а ещё', 'И потом', 'Ну и', 'А ещё'];
  for (const f of forms) {
    for (const c of conj) {
      for (const w of ['с крыши', 'ножом', 'ядом', 'таблетками']) {
        for (const sep of [' ', '... ', '… ', '\n']) {
          assert.equal(assessRisk(`${f} ${c}${sep}${w}`).level, 'urgent', `${f} ${c}${sep}${w}`);
          assert.equal(continuationLevel(`Утром чай. ${f}`, `${c}${sep}${w}`), 'urgent', `${f} + ${c}${sep}${w}`);
        }
      }
    }
    // Отдельной строкой без союза — однозначный способ с предлогом.
    for (const w of ['в окно', 'в петлю', 'В петлю.']) assert.equal(assessRisk(`${f}\n${w}`).level, 'urgent', `${f}\\n${w}`);
    // Поле эпизода или правка (FIELD_SEP): только с союзом.
    assert.equal(assessRisk(joinEdits(`Утром чай. ${f}${EDIT_SEP}в окно`)).level, 'none', `${f} | в окно`);
    assert.equal(assessRisk(joinEdits(`Утром чай. ${f}${EDIT_SEP}и в окно`)).level, 'urgent', `${f} | и в окно`);
    assert.equal(assessRisk(joinEdits(`Утром чай. ${f}${EDIT_SEP}и потом... с крыши`)).level, 'urgent', `${f} | и потом... с крыши`);
  }
  // Склейка после голого союза не превращает обычную речь в продолжение.
  for (const t of ['Отравлюсь шавермой. И... Утром дождь.', 'Без кофе мне не жить. Ну и... ладно.', 'Без кофе мне не жить. И ещё... пошла варить.']) {
    assert.equal(assessRisk(t).level, 'none', t);
  }
  // Длинная цепочка знаков после союза разбирается быстро (склейка ограничена).
  const t0 = Date.now();
  assessRisk(`Отравлюсь шавермой. И${', .'.repeat(10000)} таблетками`);
  assert.ok(Date.now() - t0 < 2000);
});

// ── QA PR 16 (93f7fbb2): самостоятельный рассказ не наследует прежний; окно доставки — только связанная фраза ──────

function qaBot({ safetyCheck, render } = {}) {
  const sent = []; const drafts = []; const c = { video: 0 };
  const bot = createBot({
    tg: { send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; } },
    checkRetryMs: 0, safetyCheck: safetyCheck || (async () => false),
    draft: (st, o) => { drafts.push(st); return modelLike(st, o); },
    metrics: makeMetrics(path.join(helpDir, `qa-${Math.random()}.jsonl`), 'test-salt-fictional-0001'),
    render: render || (async (ep, o) => { await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; }),
  });
  const chat = { id: 716300 + Math.floor(Math.random() * 1000), type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const play = () => {
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m, 'кнопка ролика есть');
    return bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
  };
  return { bot, chat, sent, drafts, c, say, play };
}
const OWN_CONCERN = 'Вечером мы гуляли у реки. Хочу его ударить.';

test('QA PR 16, п. 1: второй самостоятельный рассказ со своим concern не наследует первый', async () => {
  assert.equal(assessRisk(OWN_CONCERN).level, 'concern');
  assert.equal(continuationLevel(STORY, OWN_CONCERN), 'none', 'собственный concern — не продолжение');
  const { bot, chat, drafts, say } = qaBot();
  await say(STORY);
  await say(OWN_CONCERN);
  assert.equal(drafts.length, 2);
  assert.ok(!drafts[1].includes('Отравлюсь'), 'в черновик второго не попадает текст первого');
  assert.equal(bot.sessions.get(chat.id).story, OWN_CONCERN, 'в состоянии бота — только второй рассказ');
});

test('QA PR 16, п. 1: настоящее продолжение (обрывок после бытовой формы) объединяется с рассказом', async () => {
  assert.equal(continuationLevel(STORY, 'и хватит'), 'concern');
  const { bot, chat, drafts, say } = qaBot();
  await say(STORY);
  await say('и хватит');
  assert.equal(drafts.at(-1), `${STORY}\nи хватит`);
  assert.equal(bot.sessions.get(chat.id).story, `${STORY}\nи хватит`);
});

for (const [name, msg, expected] of [
  ['продолжение: модель получает фрагмент и одну предыдущую фразу', 'и хватит', 'Отравлюсь шавермой.\nи хватит'],
  ['самостоятельное сообщение: контекст прежнего рассказа не передаётся', OWN_CONCERN, OWN_CONCERN],
]) {
  test(`QA PR 16, п. 2, окно доставки — ${name}; «неизвестно» → 0 роликов и один ответ с контактами`, async (t) => {
    t.mock.method(console, 'error', () => {});
    let release; const hold = new Promise((r) => { release = r; });
    const inputs = []; let fail = false;
    const safetyCheck = async (x) => { if (!fail) return false; inputs.push(x); throw Object.assign(new Error('x'), { code: 'timeout' }); };
    const render = async (ep, o) => { await hold; await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; };
    const { sent, c, say, play } = qaBot({ safetyCheck, render });
    await say(STORY);
    const p = play();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    fail = true;
    const before = sent.length;
    await say(msg);
    release();
    await p;
    assert.ok(inputs.length >= 1);
    for (const x of inputs) assert.equal(x, expected);
    assert.equal(c.video, 0);
    const replies = sent.slice(before).filter((x) => /8-800-000-00-00/.test(x.text));
    assert.equal(replies.length, 1, 'ровно один ответ с контактами');
    assert.ok(replies[0].text.startsWith(TRY_LATER_TEXT));
  });
}

test('QA PR 16, разбор: собственный urgent после рассказа — остановка сразу, без черновика и роликов', async () => {
  const { sent, drafts, c, say } = qaBot();
  await say(STORY);
  await say('Вечером мы гуляли у реки. Хочу покончить с собой.');
  assert.equal(drafts.length, 1, 'черновик второго не строится');
  assert.ok(sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)));
  assert.equal(c.video, 0);
});
