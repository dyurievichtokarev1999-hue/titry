// Один отклик на ролик (решение Claude 24.11): метрики «Попадание» и «Вред» считаются по роликам, поэтому под каждым
// роликом пишется первый ответ, а «Стало тяжелее» — ещё раз, если первым был другой. Ответ и блок помощи — при каждом нажатии.
// Настоящий createBot; подтверждения проходит хелпер (tests/helpers/consent.js). Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot } from './helpers/consent.js';
import { TEXT } from '../server/bot.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));

function setup() {
  const sent = []; const fb = [];
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => { if (o.ready && !(await o.ready())) return null; sent.push({ video: true, extra }); return {}; } };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e, x) => { if (e === 'feedback') fb.push(x.value); }, forget: async () => {} };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 94001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const video = async () => {
    await say(ex.story);
    await click(`play:${bot.sessions.get(chat.id).draftId}`);
    const v = [...sent].reverse().find((m) => m.video);
    return Object.fromEntries(v.extra.reply_markup.inline_keyboard[0].map((k) => [k.callback_data.split(':')[1], k.callback_data]));
  };
  return { bot, sent, fb, say, click, video };
}

test('один отклик на ролик: повторные нажатия под тем же роликом в метрики не пишутся, ответ — каждый раз', async () => {
  const t = setup();
  const k1 = await t.video();
  for (const v of ['fit', 'fit', 'miss', 'heavier']) {
    const n = t.sent.length;
    await t.click(k1[v]);
    assert.equal(t.sent[n].text, { fit: TEXT.fit, miss: TEXT.miss, heavier: TEXT.heavier }[v], `${v}: ответ есть`);
  }
  assert.equal(t.sent.at(-1).text, helpMessage('concern'), '«Стало тяжелее» — блок помощи и при повторе');
  assert.deepEqual(t.fb, ['fit', 'heavier'], 'под первым роликом: первый ответ и «Стало тяжелее» (сигнал вреда не теряется); повторы не пишутся');
  const k2 = await t.video();
  assert.notEqual(k2.miss, k1.miss, 'у второго ролика свой номер в кнопках');
  await t.click(k2.miss); await t.click(k2.miss);
  await t.click(k1.heavier); // снова кнопка первого ролика
  assert.deepEqual(t.fb, ['fit', 'heavier', 'miss'], 'второй ролик — свой один отклик; первый — без новых');
});

test('кнопка с номером ролика, которого не было, или без номера — в метрики не пишется, ответ прежний', async () => {
  const t = setup();
  const k = await t.video();
  const cycle = k.fit.split(':')[2];
  for (const data of [`fb:fit:${cycle}:7`, `fb:fit:${cycle}:0`, `fb:fit:${cycle}:x`, `fb:fit:${cycle}`]) {
    const n = t.sent.length;
    await t.click(data);
    assert.equal(t.sent[n].text, TEXT.fit, `${data}: ответ есть`);
  }
  assert.deepEqual(t.fb, [], 'метрик нет');
});
