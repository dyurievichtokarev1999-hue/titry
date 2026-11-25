// Один отклик на ролик (решение Claude 24.11; QA PR 35 на 9319ab0): метрики «Попадание» и «Вред» считаются по роликам.
// Под каждым роликом пишется первый ответ, а «Стало тяжелее» — ещё раз, если первым был другой. Ответ и блок помощи —
// при каждом нажатии. Номер ролика — случайный, один и тот же в метриках render и feedback; отклик принимается только
// на доставленный ролик. Настоящий createBot; подтверждения проходит хелпер. Только вымышленные данные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBot } from './helpers/consent.js';
import { TEXT } from '../server/bot.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));

function setup({ cancelFirst = false } = {}) {
  const sent = []; const log = []; const offered = [];
  let calls = 0;
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''),
    sendVideo: async (c, f, extra, o = {}) => {
      offered.push(extra); // кнопки, которые были бы под роликом
      if (cancelFirst && calls++ === 0) return null; // отмена прямо перед отправкой (ready() вернул false)
      if (o.ready && !(await o.ready())) return null;
      sent.push({ video: true, extra }); return {};
    } };
  const metrics = { hash: () => 'qa-fictional', log: async (c, e, x) => { if (e === 'feedback' || e === 'render') log.push({ e, ...x }); }, forget: async () => {} };
  const bot = createBot({ tg, metrics, safetyCheck: async () => false, checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 94001, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const click = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const keys = (extra) => Object.fromEntries(extra.reply_markup.inline_keyboard[0].map((k) => [k.callback_data.split(':')[1], k.callback_data]));
  const video = async () => {
    await say(ex.story);
    await click(`play:${bot.sessions.get(chat.id).draftId}`);
    return keys(offered.at(-1));
  };
  const fb = () => log.filter((r) => r.e === 'feedback');
  return { bot, sent, log, fb, say, click, video };
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
  assert.deepEqual(t.fb().map((r) => r.value), ['fit', 'heavier'], 'под первым роликом: первый ответ и «Стало тяжелее» (сигнал вреда не теряется); повторы не пишутся');
  const k2 = await t.video();
  assert.notEqual(k2.miss, k1.miss, 'у второго ролика свой номер в кнопках');
  await t.click(k2.miss); await t.click(k2.miss);
  await t.click(k1.heavier); // снова кнопка первого ролика
  assert.deepEqual(t.fb().map((r) => r.value), ['fit', 'heavier', 'miss'], 'второй ролик — свой один отклик; первый — без новых');
});

test('сквозной: два ролика одного участника — по записям оба сигнала связаны с первым роликом, второй отдельно', async () => {
  const t = setup();
  const k1 = await t.video();
  await t.click(k1.fit); await t.click(k1.heavier);
  const k2 = await t.video();
  await t.click(k2.miss);
  // Только сохранённые записи: render и feedback с номером ролика.
  const renders = t.log.filter((r) => r.e === 'render').map((r) => r.video);
  assert.equal(renders.length, 2);
  assert.match(renders[0], /^[0-9a-f]{8}$/);
  assert.notEqual(renders[0], renders[1], 'у роликов разные номера');
  const byVideo = (id) => t.fb().filter((r) => r.video === id).map((r) => r.value);
  assert.deepEqual(byVideo(renders[0]), ['fit', 'heavier'], 'первый ролик: отклик и сигнал вреда');
  assert.deepEqual(byVideo(renders[1]), ['miss'], 'второй ролик: свой отклик');
  assert.equal(k1.fit.split(':')[3], renders[0], 'номер в кнопках — тот же, что в метрике render');
  for (const r of t.log) assert.deepEqual(Object.keys(r).filter((k) => !['e', 'value', 'video', 'seconds', 'mood', 'music', 'edits'].includes(k)), [], 'без лишних полей');
});

test('отменённая доставка: номер её ролика для метрик недопустим; доставленный следующий — допустим', async () => {
  const t = setup({ cancelFirst: true });
  const k1 = await t.video(); // отменён перед отправкой: ролика нет
  assert.ok(!t.sent.some((m) => m.video), 'ролик не отправлен');
  assert.equal(t.log.filter((r) => r.e === 'render').length, 0, 'метрики render нет');
  for (const v of ['fit', 'heavier']) await t.click(k1[v]);
  assert.deepEqual(t.fb(), [], 'отклик под недоставленным роликом не пишется');
  const k2 = await t.video();
  await t.click(k2.fit);
  assert.deepEqual(t.fb().map((r) => [r.value, r.video]), [['fit', k2.fit.split(':')[3]]], 'доставленный ролик — отклик пишется');
});

test('кнопка с номером ролика, которого не было, или без номера — в метрики не пишется, ответ прежний', async () => {
  const t = setup();
  const k = await t.video();
  const cycle = k.fit.split(':')[2];
  for (const data of [`fb:fit:${cycle}:ffffffff`, `fb:fit:${cycle}:1`, `fb:fit:${cycle}:`, `fb:fit:${cycle}`, `fb:fit:${cycle}:__proto__`]) {
    const n = t.sent.length;
    await t.click(data);
    assert.equal(t.sent[n].text, TEXT.fit, `${data}: ответ есть`);
  }
  assert.deepEqual(t.fb(), [], 'метрик нет');
});
