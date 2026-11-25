// Допуск участников и пределы обращений к модели (решение Дмитрия 24.11, Б6 п. 2; план Критика реализации 20.11).
// Критерии приёмки плана: участник из списка и вне списка; пустая и неверная конфигурация; достижение и сброс предела
// с подменными часами; два участника при заполненном общем пределе; освобождение места при каждом исходе; число
// вызовов модели с повтором; команды помощи и удаления, экран остановки. Только вымышленные данные и номера.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { TEXT, prepareBot, createBot as realCreateBot } from '../server/bot.js';
import { createBot } from './helpers/consent.js';
import { admissionFromEnv, makeAdmission } from '../server/admission.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));
const IN = 1001; const OUT = 2002; // вымышленные номера чатов

function setup({ limits, clock = { t: 0 }, draft, real = false } = {}) {
  const sent = []; const events = []; const n = { draft: 0, check: 0, forget: 0 };
  const admission = makeAdmission({ allowed: new Set([String(IN), '1003']), perDay: 2, concurrency: 1, waitMs: 50, ...limits }, { now: () => clock.t });
  const tg = { send: async (c, text) => { sent.push({ c, text }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => ({}) };
  const metrics = { hash: (id) => `h${id}`, log: async (c, e) => { events.push({ c, e }); }, forget: async () => { n.forget++; } };
  const bot = (real ? realCreateBot : createBot)({ tg, metrics, admission, checkRetryMs: 0,
    draft: draft || (async () => { n.draft++; return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; }),
    safetyCheck: async () => { n.check++; return false; },
    render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const say = (id, text) => bot.handleUpdate({ message: { chat: { id, type: 'private' }, text } });
  const texts = (id) => sent.filter((m) => m.c === id).map((m) => m.text);
  return { bot, sent, events, n, say, texts, admission, clock };
}

test('вне списка: модель не вызывается, сессии и метрик нет; короткий ответ не чаще раза в 10 минут; /delete, /help, экран остановки работают', async () => {
  const t = setup({ real: true }); // без хелпера подтверждений: вне списка до подтверждений не доходит
  await t.say(OUT, ex.story);
  await t.say(OUT, ex.story);
  assert.deepEqual(t.texts(OUT), [TEXT.notInvited], 'один ответ');
  assert.equal(t.n.draft + t.n.check, 0);
  assert.ok(!t.bot.sessions.has(OUT), 'сессии нет');
  assert.ok(!t.events.some((e) => e.c === OUT), 'метрик нет');
  await t.say(OUT, 'Не хочу жить.');
  assert.equal(t.texts(OUT).at(-1), helpMessage('urgent'), 'экран остановки');
  await t.say(OUT, '/help');
  assert.equal(t.texts(OUT).at(-1), TEXT.editHelp);
  await t.say(OUT, '/delete');
  assert.equal(t.texts(OUT).at(-1), TEXT.deleted);
  assert.ok(!t.texts(OUT).join('\n').includes(String(IN)), 'параметры допуска не раскрываются');
  await t.bot.handleUpdate({ callback_query: { id: 'q', data: 'play:1', message: { chat: { id: OUT, type: 'private' } } } });
  assert.equal(t.n.draft, 0);
});

test('в списке: черновик делается; предел на участника за 24 часа — «на сегодня достаточно», сброс через сутки', async () => {
  const t = setup();
  await t.say(IN, ex.story); await t.say(IN, ex.story);
  assert.equal(t.n.draft, 2);
  await t.say(IN, ex.story);
  assert.equal(t.n.draft, 2, 'третий рассказ — без модели');
  assert.equal(t.texts(IN).at(-1), TEXT.limitReached);
  await t.say(IN, 'Не хочу жить.'); // явная опасность и после исчерпания — экран остановки
  assert.match(t.texts(IN).join('\n'), /Для этого рассказа ролика не будет/);
  t.clock.t += 24 * 60 * 60 * 1000;
  await t.say(IN, 'Утром убежал кофе, днём искали ключи.');
  assert.equal(t.n.draft, 3, 'через сутки — снова');
  await t.say(IN, '/delete');
  assert.ok(t.texts(IN).at(-1).length > 0, '/delete работает');
});

test('общий предел: второй участник ждёт место; нет места за время ожидания — «не получилось собрать черновик»; место освобождается при ошибке', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const t = setup({ limits: { perDay: 10 }, draft: async () => { calls++; if (calls === 1) await gate; if (calls === 3) throw new Error('сбой модели'); return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; } });
  const p1 = t.say(IN, ex.story);
  await tick();
  await t.say(1003, ex.story); // место занято дольше 50 мс
  assert.equal(calls, 1, 'второй черновик модель не вызвал');
  assert.equal(t.texts(1003).at(-1), TEXT.draftFail);
  release(); await p1;
  await t.say(1003, ex.story); // второй вызов — успешно
  await t.say(1003, 'Утром убежал кофе, днём искали ключи.'); // третий вызов — ошибка модели, место освобождается
  await t.say(1003, 'Вечером соседи принесли пирог, пили чай.');
  assert.equal(calls, 4, 'после ошибки место свободно');
});

test('проверка перед роликом с повтором — в пределах общего числа мест; число вызовов модели с повтором', async () => {
  const adm = makeAdmission({ concurrency: 1, waitMs: 1000 });
  let active = 0; let peak = 0;
  const call = () => adm.run(async () => { active++; peak = Math.max(peak, active); await tick(); active--; });
  await Promise.all([call(), call(), call()]);
  assert.equal(peak, 1, 'одновременно не больше одного');
  await assert.rejects(adm.run(async () => { throw new Error('x'); }));
  await adm.run(async () => {}); // место освобождено после ошибки
  const t = setup({ limits: { concurrency: 2 } });
  await t.say(IN, ex.story);
  await t.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${t.bot.sessions.get(IN).draftId}`, message: { chat: { id: IN, type: 'private' } } } });
  assert.equal(t.n.check, 1, 'одна проверка перед роликом');
});

test('конфигурация: открытый режим без пределов; закрытый — список и пороги обязательны; неверные значения — ошибка', () => {
  assert.equal(admissionFromEnv({}), null);
  const ok = admissionFromEnv({ TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: '1001, 1003', TITRY_STORIES_PER_DAY: '3', TITRY_MODEL_CONCURRENCY: '2' });
  assert.deepEqual([...ok.allowed], ['1001', '1003']);
  assert.deepEqual([ok.perDay, ok.concurrency, ok.waitMs], [3, 2, 30000]);
  for (const env of [
    { TITRY_CLOSED_TEST: '1' },
    { TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: '', TITRY_STORIES_PER_DAY: '3', TITRY_MODEL_CONCURRENCY: '2' },
    { TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: 'анна', TITRY_STORIES_PER_DAY: '3', TITRY_MODEL_CONCURRENCY: '2' },
    { TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: '1001', TITRY_STORIES_PER_DAY: '0', TITRY_MODEL_CONCURRENCY: '2' },
    { TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: '1001', TITRY_STORIES_PER_DAY: '3' },
    { TITRY_ALLOWED_CHATS: '1001' },
    { TITRY_STORIES_PER_DAY: 'много' },
  ]) assert.throws(() => admissionFromEnv(env), { code: 'admission_config' }, JSON.stringify(env));
});

test('старт: неверный допуск — отказ admission до очистки; реальные данные без закрытого режима — отказ', async () => {
  let done = 0; const lines = [];
  const opts = { log: (l) => lines.push(l), texts: { CONSENT_TEXT: { pd: 'Окончательный вымышленный текст.' }, TEXT: { start: 'Привет.' } }, checkRender: async () => {}, cleanup: async () => { done++; }, cleanupTmp: async () => { done++; return 0; }, ledger: { load: async () => { done++; } } };
  const base = { METRICS_SALT: 'test-salt-fictional-0001', ANTHROPIC_API_KEY: 'dummy-not-a-key' };
  await assert.rejects(prepareBot({ env: { ...base, TITRY_CLOSED_TEST: '1' }, ...opts }), { stage: 'admission' });
  await assert.rejects(prepareBot({ env: { ...base, TITRY_RELEASE_REAL_DATA: '1' }, ...opts }), { stage: 'admission' });
  assert.equal(done, 0);
  await prepareBot({ env: { ...base, TITRY_CLOSED_TEST: '1', TITRY_ALLOWED_CHATS: '1001', TITRY_STORIES_PER_DAY: '3', TITRY_MODEL_CONCURRENCY: '2' }, ...opts });
  assert.equal(done, 3);
  assert.ok(!lines.join('\n').includes('1001'), 'список не в журнале');
});

test('черновик не начат из-за занятых мест — предел участника не расходуется', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const t = setup({ limits: { perDay: 1, waitMs: 20 }, draft: async () => { calls++; if (calls === 1) await gate; return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; } });
  const p1 = t.say(IN, ex.story);
  await tick();
  await t.say(1003, ex.story); // занято — «не получилось»
  assert.equal(t.texts(1003).at(-1), TEXT.draftFail);
  release(); await p1;
  await t.say(1003, ex.story);
  assert.equal(calls, 2, 'единственный рассказ дня у 1003 не потерян');
});

// Разборы 3e7df0a.
test('предел исчерпан: прежний черновик цел (▶ работает); рассказ «тяжело» получает контакты помощи', async () => {
  const t = setup({ limits: { perDay: 1 } });
  await t.say(IN, ex.story);
  const draftId = t.bot.sessions.get(IN).draftId;
  await t.say(IN, 'Хочу его ударить, злюсь весь вечер.');
  assert.equal(t.bot.sessions.get(IN).draftId, draftId, 'черновик не сброшен');
  assert.ok(t.texts(IN).includes(TEXT.limitReached));
  assert.equal(t.texts(IN).at(-1), helpMessage('concern'), 'контакты помощи');
  await t.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${draftId}`, message: { chat: { id: IN, type: 'private' } } } });
  assert.equal(t.n.check, 1, 'прежний черновик идёт в проверку и ролик');
});

test('черновика не было (сбой модели, недоступно) — предел не расходуется', async () => {
  let calls = 0;
  const t = setup({ limits: { perDay: 1 }, draft: async () => { calls++; return calls < 3 ? (calls === 1 ? { draftFailed: true, code: 'timeout' } : { unavailable: true, code: 'timeout' }) : { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; } });
  await t.say(IN, ex.story); await t.say(IN, ex.story); await t.say(IN, ex.story);
  assert.equal(calls, 3, 'два сбоя не израсходовали единственный рассказ дня');
  await t.say(IN, 'Утром убежал кофе, днём искали ключи.');
  assert.equal(calls, 3);
  assert.equal(t.texts(IN).at(-1), TEXT.limitReached);
});

test('вне списка: рассказ «тяжело» — контакты помощи; /delete — тот же честный ответ, что у участников', async () => {
  const t = setup({ real: true });
  await t.say(OUT, 'Хочу его ударить, злюсь весь вечер.');
  assert.ok(t.texts(OUT).at(-1).includes(helpMessage('concern')));
  await t.say(OUT, '/delete');
  assert.ok(t.texts(OUT).at(-1).startsWith(TEXT.deleted));
});

test('конфигурация: ожидание места не больше 10 минут', () => {
  assert.throws(() => admissionFromEnv({ TITRY_STORIES_PER_DAY: '3', TITRY_MODEL_WAIT_MS: '9999999999' }), { code: 'admission_config' });
});

// ponytail-review 3e7df0a, блокер: места заняты — проверка не делалась, ролик не уходит.
test('места заняты при проверке перед роликом — ролика нет, «очередь заполнена», модель не вызывалась', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let drafts = 0;
  const t = setup({ limits: { waitMs: 20, perDay: 10 }, draft: async () => { drafts++; if (drafts === 2) await gate; return { episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }; } });
  await t.say(IN, ex.story);
  const busy = t.say(1003, ex.story); // занимает единственное место
  await tick();
  await t.bot.handleUpdate({ callback_query: { id: 'q', data: `play:${t.bot.sessions.get(IN).draftId}`, message: { chat: { id: IN, type: 'private' } } } });
  for (let i = 0; i < 100 && t.texts(IN).at(-1) !== TEXT.busy; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.texts(IN).at(-1), TEXT.busy);
  assert.equal(t.n.check, 0, 'модель рассказ не видела');
  release(); await busy;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.n.check, 0, 'и после освобождения ролик по старому нажатию не делается');
});

test('повтор рассказа, остановленного моделью, после исчерпания предела — экран остановки, а не «достаточно»', async () => {
  let checks = 0; const sent = [];
  // Проверка модели: «опасно».
  const bot = createBot({ tg: { send: async (c, text) => { sent.push({ c, text }); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => ({}) },
    metrics: { hash: () => 'h', log: async () => {}, forget: async () => {} }, admission: makeAdmission({ allowed: new Set(['1005']), perDay: 1, concurrency: 1 }), checkRetryMs: 0,
    draft: async () => ({ episode: structuredClone(ex.episode), risk: { level: 'none' }, provider: 'claude', dropped: [] }),
    safetyCheck: async () => { checks++; return true; }, render: async (e, o) => ({ seconds: 1, duration: 24, outPath: o.outPath }) });
  const chat = { id: 1005, type: 'private' };
  await bot.handleUpdate({ message: { chat, text: ex.story } });
  await bot.handleUpdate({ callback_query: { id: 'q', data: `play:${bot.sessions.get(1005).draftId}`, message: { chat } } });
  for (let i = 0; i < 100 && !sent.some((m) => m.c === 1005 && /ролика не будет/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(checks, 1, 'модель признала опасным');
  await bot.handleUpdate({ message: { chat, text: ex.story } }); // предел (1) уже исчерпан
  const last = sent.filter((m) => m.c === 1005).at(-1).text;
  assert.notEqual(last, TEXT.limitReached);
  assert.match(last, /Для этого рассказа ролика не будет/);
});
