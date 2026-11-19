// Решение 14.11 (пункты 4, 6, 8), подтверждённое 16.11, коммит 3: недостающее и приёмка текстов Редактора.
// Только вымышленные рассказы и маркеры; модель, рендер и Telegram подставные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMetrics } from '../server/bot.js';
import { createBot } from './helpers/consent.js'; // подтверждения 6А–6Ж пройдены (хелпер)
import { assessRisk, prepareHelp, helpMessage, STOP_SCREEN_TEXT, TRY_LATER_TEXT, NOT_HEARD_TEXT } from '../server/safety.js';
import { modelLike } from './helpers/fake-model.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-1411-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
const helpFile = async (name, lineVerified) => {
  const f = path.join(dir, name);
  await fs.writeFile(f, JSON.stringify({
    region: 'RU',
    emergency: { label: 'Единый номер экстренных служб', phone: '112', verified: true },
    contacts: [{ label: 'Линия помощи (тестовая карточка)', phone: '8-800-000-00-00', hours: 'круглосуточно', verified: lineVerified }],
  }));
  return f;
};
const VERIFIED = await helpFile('verified.json', true);
const UNVERIFIED = await helpFile('unverified.json', false);

// ── (4) Линия помощи при реальных данных ───────────────────────────────────────────────────────────────

test('(4) TITRY_RELEASE_REAL_DATA=1 и verified:false у линии помощи — отказ старта (help_config)', () => {
  assert.throws(() => prepareHelp(UNVERIFIED, { env: { TITRY_RELEASE_REAL_DATA: '1' } }), { code: 'help_config' });
  assert.doesNotThrow(() => prepareHelp(VERIFIED, { env: { TITRY_RELEASE_REAL_DATA: '1' } }));
});

test('(4) без реальных данных: verified:false — старт есть, экран остановки показывает только 112', () => {
  const help = prepareHelp(UNVERIFIED, { env: {} });
  const screen = helpMessage('urgent', help);
  assert.equal((screen.match(/112/g) || []).length, 1);
  assert.ok(!screen.includes('8-800'), 'неподтверждённая линия не показывается');
  const shown = helpMessage('urgent', prepareHelp(VERIFIED, { env: {} }));
  assert.ok(shown.includes('8-800-000-00-00'), 'подтверждённая линия показывается');
});

// ── (6) «сдохнуть» ─────────────────────────────────────────────────────────────────────────────────────

test('(6) «хочу сдохнуть», «лучше бы сдохнуть», «сдохнуть бы» — urgent в любом месте; сообщение целиком «сдохну» — urgent', () => {
  for (const t of ['хочу сдохнуть', 'Лучше бы сдохнуть.', 'Сдохнуть бы.', 'Утром пила чай. Хочу сдохнуть от этой жизни. Вечером дождь.',
    'Сдохну', 'сдохну!!!', 'Сдохнуть 😭', '…сдохну…']) assert.equal(assessRisk(t).level, 'urgent', t);
  assert.equal(assessRisk('Устала, думала сдохну на этой лестнице, но дошла до дома и пила чай.').level, 'none', '«сдохну» внутри рассказа локально не трогается');
});

// ── Бот: экран остановки, подписи к фото и видео ───────────────────────────────────────────────────────

async function withBot(fn, { check = async () => false } = {}) {
  prepareHelp(VERIFIED, { env: {} });
  const d = await fs.mkdtemp(path.join(dir, 'bot-'));
  const sent = []; const c = { video: 0, files: 0, render: 0 };
  const tg = {
    send: async (id, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => { c.files++; return Buffer.from(''); }, sendVideo: async () => { c.video++; },
  };
  const bot = createBot({
    tg, checkRetryMs: 0, safetyCheck: async (t) => check(t), draft: modelLike,
    metrics: makeMetrics(path.join(d, 'm.jsonl'), 'test-salt-fictional-0001'),
    render: async (ep, o) => { c.render++; await fs.mkdir(path.dirname(o.outPath), { recursive: true }); await fs.writeFile(o.outPath, 'x'); return { outPath: o.outPath, duration: 20, seconds: 1 }; },
  });
  const chat = { id: 714111, type: 'private' };
  const send = (message) => bot.handleUpdate({ message: { chat, ...message } });
  const play = async () => {
    const m = [...sent].reverse().find((x) => x.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('play:'));
    assert.ok(m, 'кнопка ролика есть');
    await bot.handleUpdate({ callback_query: { id: 'q', data: m.extra.reply_markup.inline_keyboard[0][0].callback_data, message: { chat } } });
  };
  try { await fn({ send, play, sent, c, metricsFile: path.join(d, 'm.jsonl') }); } finally { prepareHelp(VERIFIED, { env: {} }); }
}

test('(8) подпись к фото и видео с явной опасностью → экран остановки; файл не скачивается; подписи нет в журнале и метриках', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => { logged.push(a.join(' ')); });
  t.mock.method(console, 'log', (...a) => { logged.push(a.join(' ')); });
  for (const media of [{ photo: [{ file_id: 'p1' }] }, { video: { file_id: 'v1', duration: 3 } }, { document: { file_id: 'd1' } }]) {
    await withBot(async ({ send, sent, c, metricsFile }) => {
      await send({ ...media, caption: 'Маркер-Шнырбель. Не хочу больше жить.' });
      assert.ok(sent.some((m) => m.text.startsWith(STOP_SCREEN_TEXT)), JSON.stringify(Object.keys(media)));
      assert.equal(c.files, 0, 'файл не скачивается и не обрабатывается');
      assert.equal(c.video, 0);
      const metrics = fsSync.existsSync(metricsFile) ? fsSync.readFileSync(metricsFile, 'utf8') : '';
      assert.ok(!metrics.includes('Шнырбель') && !logged.join('\n').includes('Шнырбель'), 'текста подписи нет в журнале и метриках');
    });
  }
});

test('(8) фото и видео без подписи — как раньше: без ответа и без скачивания', async () => {
  await withBot(async ({ send, sent, c }) => {
    await send({ photo: [{ file_id: 'p1' }] });
    await send({ video: { file_id: 'v1', duration: 3 } });
    assert.equal(sent.length, 0);
    assert.equal(c.files, 0);
  });
});

test('приёмка 2: экран остановки — 0 видео, нет «всё равно сделать ролик» и «подробнее», 112 ровно один раз, линия при verified:true', async () => {
  await withBot(async ({ send, sent, c }) => {
    await send({ text: 'Утром пила чай. Не хочу больше жить.' });
    const screen = sent.find((m) => m.text.startsWith(STOP_SCREEN_TEXT));
    assert.ok(screen);
    assert.equal((screen.text.match(/112/g) || []).length, 1);
    assert.ok(screen.text.includes('8-800-000-00-00'));
    assert.ok(!sent.some((m) => /всё равно|все равно/i.test(m.text) || /подробнее/i.test(m.text)));
    assert.ok(!sent.some((m) => JSON.stringify(m.extra || {}).match(/всё равно|все равно|подробнее/i)), 'и кнопок таких нет');
    assert.equal(c.video, 0);
  });
});

test('приёмка 3: «неизвестно» + локальный concern → 0 видео, ровно одно сообщение TRY_LATER_TEXT с контактами', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withBot(async ({ send, play, sent, c }) => {
    await send({ text: 'Утром я пила чай. Днём я мыла посуду. Брат опять орал, хочу его ударить.' });
    const before = sent.length;
    await play();
    const tl = sent.slice(before).filter((m) => m.text.startsWith(TRY_LATER_TEXT));
    assert.equal(tl.length, 1);
    assert.ok(tl[0].text.includes('8-800-000-00-00'));
    assert.equal(c.video, 0);
  }, { check: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); } });
});

// ── Тексты Редактора ───────────────────────────────────────────────────────────────────────────────────

test('приёмка 1: три текста Редактора — точное совпадение', () => {
  assert.equal(STOP_SCREEN_TEXT, 'Для этого рассказа ролика не будет. Если тебе или кому-то рядом сейчас угрожает опасность, звони 112.');
  assert.equal(TRY_LATER_TEXT, 'Не получилось собрать ролик. Если захочешь, попробуй позже.');
  assert.equal(NOT_HEARD_TEXT, 'Не получилось разобрать голосовое. Напиши, пожалуйста, текстом.');
});

test('приёмка 5: старых строк нет ни в коде, ни в тестах, ни в документах', async () => {
  const OLD = ['Не рас' + 'слышал', 'Попробуй ' + 'позже.'];
  const root = new URL('../', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const e of fsSync.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', '.claude'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|mjs|md|html|json)$/.test(e.name)) files.push(p);
  } };
  for (const sub of ['server', 'engine', 'tests', 'docs', 'config']) walk(path.join(root, sub));
  for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) if (fsSync.existsSync(path.join(root, f))) files.push(path.join(root, f));
  for (const f of files) {
    const text = fsSync.readFileSync(f, 'utf8');
    for (const old of OLD) assert.ok(!text.includes(old), `${path.relative(root, f)}: «${old}»`);
  }
});
