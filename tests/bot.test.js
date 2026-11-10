import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEdit, createBot, draftMessage, makeMetrics, parseEdit } from '../server/bot.js';
import { draftRuleBased } from '../server/draft.js';

// Есть ли значение id среди значений полей журнала (рекурсивно). Подстроку не ищем:
// «:42» бывает во времени поля at — из-за этого тест падал по часам (QA, 10.11).
function logHasValue(log, id) {
  const walk = (v) => (v !== null && typeof v === 'object' ? Object.values(v).some(walk) : String(v) === String(id));
  return log.split('\n').filter(Boolean).some((line) => walk(JSON.parse(line)));
}

test('разбор правок', () => {
  assert.deepEqual(parseEdit('2: вечерний звонок'), { op: 'row', n: 2, value: 'вечерний звонок' });
  assert.deepEqual(parseEdit('2: Друг — вечерний звонок'), { op: 'row', n: 2, role: 'Друг', value: 'вечерний звонок' });
  assert.deepEqual(parseEdit('-3'), { op: 'delete', n: 3 });
  assert.deepEqual(parseEdit('+ Окно — долгий вечер'), { op: 'add', role: 'Окно', value: 'долгий вечер' });
  assert.deepEqual(parseEdit('Название: Письмо, которое ушло'), { op: 'title', value: 'Письмо, которое ушло' });
  assert.deepEqual(parseEdit('после: -'), { op: 'post', value: '-' });
  assert.equal(parseEdit('Сегодня был длинный день'), null);
});

test('правки применяются и соблюдают лимиты', () => {
  const { episode } = draftRuleBased('Утром работа. Днём встреча с другом. Вечером ужин. Потом прогулка.', { date: '2026-11-05' });
  const n = episode.rows.length;
  assert.equal(applyEdit(episode, { op: 'row', n: 1, role: 'Утро', value: 'работа' }), null);
  assert.equal(episode.rows[0].source, 'работа', 'отредактированная строка опирается на слова самого человека');
  assert.equal(applyEdit(episode, { op: 'delete', n: 99 }), 'Строки 99 нет.');
  assert.equal(applyEdit(episode, { op: 'delete', n: 1 }), null);
  assert.equal(episode.rows.length, n - 1);
  assert.equal(applyEdit(episode, { op: 'post', value: '-' }), null);
  assert.equal(episode.post.text, '');
  assert.match(draftMessage(episode), /Похоже на твой день/);
});

const playId = (tg) => {
  const kb = [...tg.sent].reverse().find((m) => m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard);
  return kb.extra.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
};

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    send: async (chat, text, extra) => { sent.push({ type: 'text', text, extra }); },
    action: async () => {},
    answer: async () => {},
    fileBuffer: async () => Buffer.from('ogg'),
    sendVideo: async (chat, file, extra) => { const st = await fs.stat(file); sent.push({ type: 'video', size: st.size, extra }); },
  };
}

test('сценарий бота: рассказ → правка → ролик → отклик; метрики без текста рассказа', async () => {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-test-'));
  const metrics = makeMetrics(path.join(dir, 'm.jsonl'), 'salt');
  const rendered = [];
  const render = async (ep, opts) => { rendered.push(ep); await fs.mkdir(path.dirname(opts.outPath), { recursive: true }); await fs.writeFile(opts.outPath, 'mp4'); return { outPath: opts.outPath, duration: 24, seconds: 1 }; };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics, render, draft: (s, o) => import('../server/draft.js').then((m) => m.makeDraft(s, { ...o, provider: 'manual' })) });
  const chat = { id: 42, type: 'private' };
  const story = 'Сегодня я долго правил письмо и отправил его. Вечером позвонил друг. Потом ужин и сериал.';

  await bot.handleUpdate({ message: { chat, text: '/start' } });
  await bot.handleUpdate({ message: { chat, text: story } });
  assert.ok(tg.sent.some((m) => /Похоже на твой день/.test(m.text)));
  await bot.handleUpdate({ message: { chat, text: '1: Письмо — отправлено' } });
  await bot.handleUpdate({ callback_query: { id: 'q1', data: `mood:${playId(tg)}`, message: { chat } } });
  await bot.handleUpdate({ callback_query: { id: 'q2', data: `play:${playId(tg)}`, message: { chat } } });
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].rows[0].value, 'отправлено');
  // Настроение не названо → quiet (10.11); кнопка плёнки переключает по кругу quiet → warm.
  assert.equal(rendered[0].mood, 'warm');
  assert.ok(tg.sent.some((m) => m.type === 'video'));
  await bot.handleUpdate({ callback_query: { id: 'q3', data: 'fb:heavier', message: { chat } } });
  assert.ok(tg.sent.some((m) => /112/.test(m.text)));

  const log = await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8');
  assert.ok(!log.includes('письмо'), 'текст рассказа не попадает в метрики');
  assert.ok(!logHasValue(log, 42), 'id чата не хранится в открытом виде');
  assert.match(log, /"event":"feedback","value":"heavier"/);

  await bot.handleUpdate({ message: { chat, text: '/delete' } });
  assert.equal((await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8')).trim(), '');
  assert.equal(bot.sessions.has(42), false);
});

test('бот: срочный риск — без ролика, с экраном помощи; групповые чаты игнорируются', async () => {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-test-'));
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render: async () => { throw new Error('не должно вызываться'); }, draft: (s, o) => import('../server/draft.js').then((m) => m.makeDraft(s, { ...o, provider: 'manual' })) });
  await bot.handleUpdate({ message: { chat: { id: 7, type: 'private' }, text: 'Сегодня понял, что не хочу больше жить.' } });
  assert.ok(tg.sent.some((m) => /Сейчас важнее не титры/.test(m.text)));
  assert.ok(!tg.sent.some((m) => /Похоже на твой день/.test(m.text)));
  const before = tg.sent.length;
  await bot.handleUpdate({ message: { chat: { id: 8, type: 'group' }, text: 'Длинная история про день в группе' } });
  assert.equal(tg.sent.length, before);
});

test('метрики: проверка id не путает время «:42» с id чата (воспроизводимо, фиксированное время)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T00:42:42.042Z') });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-test-42-'));
  try {
    const metrics = makeMetrics(path.join(dir, 'm.jsonl'), 'salt');
    await metrics.log(42, 'start');
    const log = await fs.readFile(path.join(dir, 'm.jsonl'), 'utf8');
    assert.ok(log.includes(':42'), 'время в поле at действительно содержит «:42»');
    assert.ok(!logHasValue(log, 42), 'id чата в открытом виде нет');
    assert.ok(logHasValue(log, metrics.hash(42)), 'вместо id — хэш');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
