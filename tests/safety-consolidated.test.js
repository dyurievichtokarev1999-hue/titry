// Приёмка сводного PR безопасности (решение владельца кода 13.11 15:00). Настоящие createBot / createApp / makeGate;
// подставные: модельная проверка, рендер, Telegram, распознавание. Только вымышленные рассказы и маркеры.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBot, TEXT, prepareBot } from '../server/bot.js';
import { createApp } from '../server/app.js';
import { makeGate, modelModeAtStart } from '../server/gate.js';
import { assessRisk, prepareHelp, helpMessage, tryLaterMessage, threatPhrase, threatErrors, HOUSEHOLD_IDIOMS, STOP_SCREEN_TEXT, NOT_HEARD_TEXT } from '../server/safety.js';
import { modelLike } from './helpers/fake-model.js';

// Контакты с проверенной линией помощи (вымышленный стенд теста): экран остановки — 112 и линия помощи.
const helpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sc-help-'));
const HELP_FILE = path.join(helpDir, 'help.json');
await fs.writeFile(HELP_FILE, JSON.stringify({
  region: 'RU',
  emergency: { label: 'Единый номер экстренных служб', phone: '112', verified: true },
  contacts: [{ label: 'Линия помощи (тестовая карточка)', phone: '8-800-000-00-00', hours: 'круглосуточно', verified: true }],
}));
prepareHelp(HELP_FILE);
test.after(() => fs.rm(helpDir, { recursive: true, force: true }));

const STOP = (t) => t.startsWith(STOP_SCREEN_TEXT) && t.includes('112') && t.includes('Линия помощи');
const NOT_DONE = /не завершил|не завершилась/;
// Вымышленный рассказ: три фразы, из которых «модель» делает строки (helpers/fake-model.js).
const SAFE = 'Утром я пила чай на кухне. Днём я гуляла в парке. Вечером я пекла пирог.';
const chat = { id: 78001, type: 'private' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await tick(); };

function bot({ check = () => false, hasKey, transcribe, render, draft = modelLike } = {}) {
  const sent = []; const events = []; const c = { check: 0, render: 0, video: 0 };
  const tg = {
    send: async (x, t) => { sent.push(t); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { c.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, ev, extra = {}) => { events.push({ ev, ...extra }); }, forget: async () => {} };
  const b = createBot({
    tg, metrics, draft, checkRetryMs: 0, ...(hasKey ? { hasKey } : {}), ...(transcribe ? { transcribe } : {}),
    safetyCheck: async (t) => { c.check++; return check(t, c.check); },
    render: async (e, o) => { c.render++; if (render) await render(); return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const s = () => b.sessions.get(chat.id);
  return {
    b, sent, events, c, s,
    say: (text) => b.handleUpdate({ message: { chat, text } }),
    voice: (extra = {}) => b.handleUpdate({ message: { chat, voice: { file_id: 'f', duration: 3 }, ...extra } }),
    photo: (caption) => b.handleUpdate({ message: { chat, photo: [{ file_id: 'p' }], caption } }),
    play: () => b.handleUpdate({ callback_query: { id: 'q', data: `play:${s().draftId}`, message: { chat } } }),
  };
}

// ── 1. Явная опасность на каждом входе → 0 роликов, экран остановки с 112 и линией помощи ─────────────

test('явная опасность: текст, «/текст», голос, подпись к фото, подпись к голосовому, правка → 0 роликов, экран остановки', async () => {
  const inputs = {
    'текст': (x) => x.say(`${SAFE} Не хочу больше жить.`),
    '«/текст»': (x) => x.say('/start не хочу больше жить'),
    'голос': (x) => x.voice(),
    'подпись к фото': (x) => x.photo('Не хочу больше жить.'),
    'подпись к голосовому': (x) => x.voice({ caption: 'Не хочу больше жить.' }),
  };
  for (const [name, act] of Object.entries(inputs)) {
    const x = bot({ transcribe: async () => (name === 'голос' ? 'Не хочу больше жить.' : 'Утром я пила чай.') });
    await act(x);
    await x.play();
    assert.equal(x.c.video, 0, name); assert.equal(x.c.render, 0, name);
    assert.ok(STOP(x.sent.at(-1)), `${name}: ${x.sent.at(-1)}`);
  }
  const e = bot();
  await e.say(SAFE);
  assert.ok(e.s().episode, 'черновик есть');
  await e.say('+ Мысль — не хочу больше жить');
  await e.play();
  assert.equal(e.c.video, 0, 'правка'); assert.ok(STOP(e.sent.at(-1)), 'правка');
});

test('явная опасность в окне «после проверки — до отправки» (текст, голос, подпись) → ролик отменён, экран остановки', async () => {
  for (const [name, act] of [
    ['текст', (x) => x.say('Не хочу больше жить.')],
    ['голос', (x) => x.voice()],
    ['подпись', (x) => x.photo('Не хочу больше жить.')],
  ]) {
    const r = deferred();
    const x = bot({ render: () => r.promise, transcribe: async () => 'Не хочу больше жить.' });
    await x.say(SAFE);
    const p = x.play();
    await waitFor(() => x.c.render === 1);
    await act(x);
    r.resolve(); await p;
    assert.equal(x.c.video, 0, name);
    assert.ok(STOP(x.sent.at(-1)), name);
  }
});

test('окно до отправки: текст ждёт одной модельной проверки; эмодзи и «ок/спасибо» — нет', async () => {
  const r = deferred(); const m = deferred();
  const x = bot({ render: () => r.promise, check: (t) => (t.includes('Утром я пила чай') ? false : m.promise) });
  await x.say(SAFE);
  const p = x.play();
  await waitFor(() => x.c.render === 1);
  await x.say('спасибо!'); await x.say('👍');
  assert.equal(x.c.check, 1, 'короткие ответы и эмодзи модель не ждут');
  const q = x.say('А вечером пришла соседка');
  r.resolve(); for (let i = 0; i < 10; i++) await tick();
  assert.equal(x.c.video, 0, 'отправка ждёт проверки сообщения');
  m.resolve(true); await q; await p;
  assert.equal(x.c.check, 2);
  assert.equal(x.c.video, 0, 'модель — опасно: ролик отменён');
  assert.ok(STOP(x.sent.at(-1)));
});

test('окно до отправки: голос не распознался — ролик не отменяется, «не расслышал»', async () => {
  const r = deferred();
  const x = bot({ render: () => r.promise, transcribe: async () => '' });
  await x.say(SAFE);
  const p = x.play();
  await waitFor(() => x.c.render === 1);
  await x.voice();
  r.resolve(); await p;
  assert.equal(x.c.video, 1);
  assert.ok(x.sent.includes(NOT_HEARD_TEXT));
  assert.doesNotMatch(x.sent.join('\n'), NOT_DONE);
});

// ── 2. Устойчивые выражения из закрытого списка → ролик; голые формы → остановка ─────────────────────

test('условие 5: бытовые дополнения из закрытого списка — none и ролик; голые формы — urgent и остановка', async () => {
  assert.deepEqual([...HOUSEHOLD_IDIOMS], ['отравлюсь шавермой', 'без кофе мне не жить', 'убить готова за кофе']);
  const idioms = ['Отравлюсь шавермой.', 'Без кофе мне не жить.', 'Убить готова за кофе.', 'ОТРАВЛЮСЬ   ШАВЕРМОЙ!', 'Без кофе, мне не жить.', 'Отравлюсь шавермой 😅'];
  for (const t of idioms) assert.equal(assessRisk(t).level, 'none', t);
  for (const t of ['Отравлюсь.', 'Отравлюсь', 'Мне не жить.', 'Мне не жить', 'Отравлюсь шавермой. Отравлюсь.', 'Без кофе мне не жить. Мне не жить.', 'Отравлюсь таблетками.', 'Отравлюсь шавермой с крысиным ядом.', 'Отравлюсь шавермой, честно.', 'Без кофе мне не жить\nправда'])
    assert.equal(assessRisk(t).level, 'urgent', t);
  for (const t of ['Отравлюсь шавермой', 'Без кофе мне не жить', 'Убить готова за кофе']) {
    const x = bot();
    await x.say(`${SAFE} ${t}.`);
    await x.play();
    assert.equal(x.c.video, 1, t);
    assert.ok(!x.sent.some(STOP), `${t}: остановок 0`);
  }
  for (const t of ['Отравлюсь', 'Мне не жить']) {
    const x = bot();
    await x.say(t);
    assert.ok(STOP(x.sent.at(-1)), t);
    assert.equal(x.c.video, 0);
  }
});

// ── 3. Нет ключа ────────────────────────────────────────────────────────────

test('нет ключа: «Привет» и обычный рассказ — обычный ответ и ролик, 0 «проверка не завершилась»', async () => {
  const x = bot({ hasKey: () => false, draft: (st, o) => modelLike(st, o) });
  await x.say('Привет');
  assert.equal(x.sent.at(-1), TEXT.more);
  await x.say(SAFE);
  await x.play();
  assert.equal(x.c.video, 1);
  assert.equal(x.c.check, 0, 'модель не вызывается');
  assert.doesNotMatch(x.sent.join('\n'), NOT_DONE);
});

test('нет ключа: одна строка-предупреждение при старте; при TITRY_RELEASE_REAL_DATA=1 — отказ старта', async () => {
  const lines = [];
  assert.equal(modelModeAtStart({ env: {}, log: (l) => lines.push(l) }), 'local_only');
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['at', 'code', 'level', 'mode', 'stage']);
  assert.equal(modelModeAtStart({ env: { ANTHROPIC_API_KEY: 'test-dummy' }, log: (l) => lines.push(l) }), 'model');
  assert.equal(lines.length, 1, 'с ключом строки нет');
  assert.throws(() => modelModeAtStart({ env: { TITRY_RELEASE_REAL_DATA: '1' }, log: () => {} }), { code: 'no_key' });
  let cleaned = 0;
  await assert.rejects(prepareBot({ env: { METRICS_SALT: 'test-salt-fictional-0001', TITRY_RELEASE_REAL_DATA: '1' }, cleanup: async () => { cleaned++; }, cleanupTmp: async () => 0, ledger: { load: async () => {} }, log: () => {} }), { code: 'no_key' });
  assert.equal(cleaned, 0, 'бот не стартует');
});

test('нет ключа: монтажная — рендер по локальному фильтру, без 503', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sc-'));
  const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
  let renders = 0;
  const server = createApp({ dataDir, hasKey: () => false, safetyCheck: async () => { throw new Error('не должна вызываться'); }, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episode: ex.episode, story: ex.story }) });
    assert.equal(res.status, 200); assert.equal(renders, 1);
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

// ── 4. «Неизвестно» ──────────────────────────────────────────────────────────

test('«неизвестно» и после повтора: локально чисто → ролик; есть concern → ролика нет, «не получилось» и контакты', async () => {
  const fail = () => { throw Object.assign(new Error('x'), { code: 'timeout' }); };
  const x = bot({ check: fail });
  await x.say(SAFE);
  await x.play();
  assert.equal(x.c.check, 2, 'один повтор');
  assert.equal(x.c.video, 1);
  assert.doesNotMatch(x.sent.join('\n'), NOT_DONE);
  const y = bot({ check: fail });
  await y.say(`${SAFE} Я злюсь на брата и хочу его ударить.`);
  assert.equal(assessRisk(y.s().story).level, 'concern');
  await y.play();
  assert.equal(y.c.check, 2);
  assert.equal(y.c.video, 0);
  assert.equal(y.sent.at(-1), tryLaterMessage());
  assert.match(y.sent.at(-1), /112/);
});

test('шлюз: повтор через паузу, исход «неизвестно» с кодом; второй ответ засчитывается', async () => {
  const waits = [];
  let n = 0;
  const g = makeGate({ check: async () => { n++; if (n === 1) throw Object.assign(new Error('x'), { code: 'timeout' }); return false; }, retryDelayMs: 3000, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await g.verify('s', 'рассказ', null, 'рассказ'), { ok: true });
  assert.deepEqual(waits, [3000]);
  const h = makeGate({ check: async () => 'не булево', sleep: async () => {} });
  assert.deepEqual(await h.verify('s', 'рассказ', null, 'рассказ'), { unknown: true, code: 'bad_response' });
});

// ── 5. Безопасный рассказ → ровно один вызов модельной проверки ─────────────────

test('безопасный рассказ: от рассказа до ролика ровно один вызов модельной проверки', async () => {
  const x = bot();
  await x.say(SAFE);
  await x.say('название: Тихий день');
  await x.play();
  assert.equal(x.c.video, 1);
  assert.equal(x.c.check, 1);
});

// ── 6. PR 14: угроза не в титрах; прошедшее время и местоимения по-прежнему останавливают ────────────

test('PR 14: слабая угроза другому («конец») — не в титрах (без остановки); насилие и угроза рассказчику в прошедшем времени и через местоимения — остановка', async () => {
  for (const t of ['Брату — не жить', 'Соседу — ноги переломаю', 'Ему — конец']) assert.equal(threatPhrase(t), true, t);
  const story = `${SAFE} Брату конец.`;
  const ep = { title: 'Чай', genre: 'драма', lead: 'ты', rows: [{ role: 'Брату', value: 'конец', source: 'Брату конец' }], post: { text: '', source: '' } };
  assert.deepEqual(threatErrors(story, ep).map((e) => e.path), ['rows.0']);
  const x = bot();
  await x.say(SAFE);
  await x.say('+ Брату — конец');
  assert.equal(x.sent.at(-1), TEXT.editExcluded);
  assert.doesNotMatch(JSON.stringify(x.s().episode), /конец/);
  for (const t of ['Вчера меня избили.', 'Он угрожал мне ножом.', 'Она била меня.', 'Меня били в школе.', 'На меня напали у подъезда.', 'Мне угрожали ножом.', 'Он меня избил.']) {
    assert.equal(assessRisk(t).level, 'urgent', t);
    const y = bot();
    await y.say(`${SAFE} ${t}`);
    assert.ok(STOP(y.sent.at(-1)), t);
    assert.equal(y.c.video, 0);
  }
  for (const t of ['Он угрожал мне увольнением и ножом.', 'Он угрожал мне судом и пистолетом.']) assert.equal(assessRisk(t).level, 'urgent', t);
  for (const t of ['На меня напала какая-то собака.', 'На меня напал сосед.']) assert.equal(assessRisk(t).level, 'urgent', t);
  // Осознанно: бытовая угроза и оружие в разных предложениях локально не связываются — это ловит модельная проверка.
  assert.equal(assessRisk('Он угрожал мне увольнением. Потом достал нож.').level, 'none');
  for (const t of ['Он угрожал мне увольнением.', 'Начальник угрожал мне по телефону увольнением.', 'Меня била дрожь.', 'Дед бил меня по плечу.',
    'На меня напала тоска.', 'На меня напала лень.', 'На меня напал жор.', 'На меня напал сон.', 'На меня тоска напала.', 'На меня напала такая тоска.', 'На меня напала дикая лень.', 'На меня вдруг такая лень напала.']) assert.notEqual(assessRisk(t).level, 'urgent', t);
});

// ── 7. В журналах и метриках нет текстов рассказов, расшифровок и подписей ──────────────────────────

test('журнал и метрики: нет текстов рассказа, расшифровки, подписи и правки (поиск по вымышленным маркерам)', async () => {
  const out = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map(String).join(' '));
  const events = [];
  try {
    const fail = () => { throw Object.assign(new Error('сбой Квазимир'), { code: 'timeout' }); };
    for (const check of [() => false, () => true, fail]) {
      const r = deferred();
      const x = bot({ check, render: () => r.promise, transcribe: async () => 'Утром Брумзель пил чай.' });
      await x.say('Утром я пила чай с Квазимиром. Днём я гуляла в парке Зюзельфрон. Вечером я пекла пирог.');
      await x.say('название: Вечер Глимбуша');
      const p = x.play();
      await waitFor(() => x.c.render === 1 || x.c.check >= 2);
      await x.photo('Подпись Шнырбель хочу его ударить');
      await x.voice({ caption: 'Подпись Тракмеля' });
      await x.say('Ворпель опять пришёл');
      r.resolve(); await p;
      events.push(...x.events);
    }
  } finally { Object.assign(console, saved); }
  const all = `${out.join('\n')}\n${JSON.stringify(events)}`.toLowerCase();
  for (const m of ['квазимир', 'зюзельфрон', 'глимбуш', 'брумзель', 'шнырбель', 'тракмел', 'ворпель']) assert.ok(!all.includes(m), `«${m}» в журнале или метриках`);
});

// ── 8. help.json без «Россия» → отказ старта (подробно — tests/help-startup.test.js) ─────────────────

test('help.json без региона RU → отказ старта; экран остановки — 112 и линия помощи', async () => {
  const f = path.join(helpDir, 'kz.json');
  await fs.writeFile(f, JSON.stringify({ region: 'KZ', emergency: { label: 'Экстренные', phone: '112', verified: true }, contacts: [{ label: 'Линия помощи', phone: '8-800-000-00-00', verified: true }] }));
  const ru = path.join(helpDir, 'ru.json');
  await fs.writeFile(ru, JSON.stringify({ region: 'RU', emergency: { label: 'Экстренные', phone: '112', verified: true }, contacts: [{ label: 'Линия помощи', phone: '8-800-000-00-00', verified: true }] }));
  assert.ok(prepareHelp(ru), 'контроль: тот же файл с регионом RU проходит');
  assert.throws(() => prepareHelp(f), { code: 'help_config' });
  await assert.rejects(prepareBot({ env: { METRICS_SALT: 'test-salt-fictional-0001', ANTHROPIC_API_KEY: 'test-dummy' }, helpFile: f, cleanup: async () => {}, cleanupTmp: async () => 0, ledger: { load: async () => {} }, log: () => {} }), { stage: 'help.load', code: 'help_config' });
  prepareHelp(HELP_FILE);
  assert.ok(STOP(helpMessage('urgent')));
  assert.doesNotMatch(helpMessage('urgent'), /подробнее|всё равно/i, 'без «подробнее» и без «всё равно сделать ролик»');
});

// ── Разбор: повторное «Смотреть титры» после отмены, рендер после отмены, двойное «не получилось» ────────

test('отмена ролика (concern + «неизвестно») не переносится на новое «Смотреть титры»; рендер отменённой доставки не запускается', async () => {
  const d = deferred();
  let n = 0;
  const x = bot({ check: (t) => (t.includes('Утром я пила чай') ? (++n === 1 ? d.promise : false) : (() => { throw Object.assign(new Error('x'), { code: 'timeout' }); })()) });
  await x.say(SAFE);
  const p1 = x.play(); await tick();
  await x.say('Убью брата'); // concern, модель «неизвестно» — доставка 1 отменена
  assert.equal(x.sent.at(-1), tryLaterMessage());
  const p2 = x.play(); // новая доставка, пока первая ещё ждёт проверки
  d.resolve(false);
  await p1; await p2;
  assert.equal(x.c.render, 1, 'отменённая доставка рендер не запускает');
  assert.equal(x.c.video, 1, 'новая доставка — ролик');
  assert.equal(x.sent.filter((t) => t === tryLaterMessage()).length, 1);
});

test('предел ожидания истёк при concern, затем проверка вернула «неизвестно» — «не получилось» один раз', async () => {
  const r = deferred(); const m = deferred();
  const sent = []; let video = 0; let renders = 0;
  const b = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { video++; } },
    metrics: { hash: () => 'f', log: async () => {}, forget: async () => {} }, draft: modelLike, checkRetryMs: 0, holdWaitMs: 30,
    safetyCheck: async (t) => (t.includes('Утром я пила чай') ? false : m.promise),
    render: async (e, o) => { renders++; await r.promise; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  await b.handleUpdate({ message: { chat, text: SAFE } });
  const p = b.handleUpdate({ callback_query: { id: 'q', data: `play:${b.sessions.get(chat.id).draftId}`, message: { chat } } });
  await waitFor(() => renders === 1);
  const q = b.handleUpdate({ message: { chat, text: 'Убью брата' } });
  r.resolve(); await p;
  assert.equal(video, 0);
  m.resolve(Promise.reject(Object.assign(new Error('x'), { code: 'timeout' }))); await q;
  assert.equal(sent.filter((t) => t === tryLaterMessage()).length, 1);
});

// ── КРИТИКА PR 16 (решение владельца кода 13.11 20:15) ──────────────────────────────────────────────────

const voiceAt = (x, caption) => x.b.handleUpdate({ message: { chat, voice: { file_id: 'f', duration: 3 }, caption } });
async function inWindow(opts, act) {
  const r = deferred();
  const x = bot({ ...opts, render: () => r.promise });
  await x.say(SAFE);
  const p = x.play();
  await waitFor(() => x.c.render === 1);
  await act(x);
  r.resolve(); await p;
  return x;
}

test('п. 1: явный сигнал в подписи к голосовому — экран остановки без ожидания распознавания (задержка, отказ, пусто)', async () => {
  for (const [name, transcribe] of [
    ['распознавание висит', () => new Promise(() => {})],
    ['распознавание отказало', async () => { throw new Error('stt'); }],
    ['пустая расшифровка', async () => ''],
  ]) {
    const x = await inWindow({ transcribe }, (y) => voiceAt(y, 'Не хочу больше жить.'));
    assert.equal(x.c.video, 0, name);
    assert.ok(STOP(x.sent.at(-1)), name);
  }
  // Вне окна — тоже без распознавания.
  const y = bot({ transcribe: () => new Promise(() => {}) });
  await voiceAt(y, 'Не хочу больше жить.');
  assert.ok(STOP(y.sent.at(-1)));
});

test('п. 1: чистая подпись + пустая расшифровка → ролик, «не расслышал»; бытовая фраза из списка в подписи → ролик, 0 остановок', async () => {
  const x = await inWindow({ transcribe: async () => '' }, (y) => voiceAt(y, 'Вечером пила чай.'));
  assert.equal(x.c.video, 1);
  assert.ok(x.sent.includes(NOT_HEARD_TEXT));
  const z = await inWindow({ transcribe: async () => 'Днём гуляла.' }, (y) => voiceAt(y, 'Отравлюсь шавермой.'));
  assert.equal(z.c.video, 1);
  assert.ok(!z.sent.some(STOP));
});

test('п. 1: concern в подписи держит «неизвестно» до конца проверки: распознавание зависло → ролика нет, один ответ с контактами', async () => {
  const r = deferred();
  const sent = []; let video = 0;
  const b = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { video++; } },
    metrics: { hash: () => 'f', log: async () => {}, forget: async () => {} }, draft: modelLike, checkRetryMs: 0, checkBudgetMs: 40, holdWaitMs: 200,
    transcribe: () => new Promise(() => {}), safetyCheck: async () => false,
    render: async (e, o) => { await r.promise; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  await b.handleUpdate({ message: { chat, text: SAFE } });
  const p = b.handleUpdate({ callback_query: { id: 'q', data: `play:${b.sessions.get(chat.id).draftId}`, message: { chat } } });
  await tick(); await tick();
  b.handleUpdate({ message: { chat, voice: { file_id: 'f', duration: 3 }, caption: 'Я злюсь на брата и хочу его ударить.' } });
  await tick();
  r.resolve(); await p;
  assert.equal(video, 0);
  assert.equal(sent.filter((t) => t === tryLaterMessage()).length, 1);
});

// п. 2: матрица — обычный вход и окно доставки × локальный режим (нет ключа) и модель «неизвестно».
const MATRIX = {
  'явная угроза другому': 'Брата прикончу.',
  'угроза через местоимение': 'Брат опять орал. Ему не жить.',
  'совершённое насилие': 'Я закопала соседа.',
  'вчера меня избили': 'Вчера меня избили.',
  'угроза ножом': 'Он угрожал мне ножом.',
  'насилие над другим': 'Вчера его избили.',
};
const MODES = {
  'локальный режим': { hasKey: () => false },
  'модель «неизвестно»': { check: (t) => { throw Object.assign(new Error('x'), { code: 'timeout' }); } },
};
test('п. 2: явная угроза и совершённое насилие → 0 видео и экран помощи на обычном входе и в окне; гипербола → ролик', async () => {
  for (const [mode, opts] of Object.entries(MODES)) {
    for (const [name, phrase] of Object.entries(MATRIX)) {
      assert.equal(assessRisk(phrase).level, 'urgent', name);
      const a = bot(opts);
      await a.say(`${SAFE} ${phrase}`);
      await a.play();
      assert.equal(a.c.video, 0, `${mode}, вход: ${name}`);
      assert.ok(STOP(a.sent.at(-1)), `${mode}, вход: ${name}`);
      const w = await inWindow(opts, (y) => y.say(phrase));
      assert.equal(w.c.video, 0, `${mode}, окно: ${name}`);
      assert.ok(STOP(w.sent.at(-1)), `${mode}, окно: ${name}`);
    }
    const g = bot(opts);
    await g.say(`${SAFE} Убить готова за кофе.`);
    await g.play();
    assert.equal(g.c.video, 1, `${mode}: гипербола на входе`);
    const gw = await inWindow(opts, (y) => y.say('Убить готова за кофе.'));
    assert.equal(gw.c.video, 1, `${mode}: гипербола в окне`);
    assert.ok(!gw.sent.some(STOP));
  }
  // Новых concern нет: гнев «убью его, если…» — прежний concern, «Брату конец» и пожелания — none.
  assert.equal(assessRisk('Убью его, если опоздает.').level, 'concern');
  for (const t of ['Брату конец, если мама узнает.', 'Иди сдохни.', 'Мама меня придушит за вазу.', 'Малыш спит, он не проснётся, если не шуметь.',
    'Я бы убил брата.', 'Задушу тебя в объятиях!', 'Торт вкусный, прикончу его завтра.', 'Урыл брата в шахматы.']) assert.notEqual(assessRisk(t).level, 'urgent', t);
});

test('п. 3: второй текст прямо перед истечением бюджета первого — результат его проверки применён к отправке', async () => {
  const r = deferred(); const second = deferred();
  const sent = []; let video = 0; let n = 0;
  const b = createBot({
    tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { video++; } },
    metrics: { hash: () => 'f', log: async () => {}, forget: async () => {} }, draft: modelLike, checkRetryMs: 0, checkBudgetMs: 150, holdWaitMs: 2000,
    safetyCheck: async (t) => (t.includes('Утром я пила чай') ? false : (++n === 1 ? new Promise(() => {}) : second.promise)),
    render: async (e, o) => { await r.promise; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  await b.handleUpdate({ message: { chat, text: SAFE } });
  const p = b.handleUpdate({ callback_query: { id: 'q', data: `play:${b.sessions.get(chat.id).draftId}`, message: { chat } } });
  await tick(); await tick();
  b.handleUpdate({ message: { chat, text: 'Пила чай с соседкой' } }); // проверка зависла: бюджет 150 мс
  r.resolve();
  await new Promise((res) => setTimeout(res, 120));
  const q = b.handleUpdate({ message: { chat, text: 'А потом пришёл сосед' } }); // за 30 мс до истечения бюджета первого
  setTimeout(() => second.resolve(true), 100); // ответ позже бюджета первого, но в пределах своего
  await q; await p;
  assert.equal(video, 0, 'результат второй проверки (опасно) применён до отправки');
  assert.ok(STOP(sent.at(-1)));
});

test('п. 3: жёсткий предел исчерпан, локально чисто → 1 ролик; «неизвестно» + concern → 0 отправок и один ответ с контактами', async () => {
  for (const [text, expectVideo] of [['Пила чай с соседкой', 1], ['Я злюсь на брата и хочу его ударить.', 0]]) {
    const r = deferred();
    const sent = []; let video = 0;
    const b = createBot({
      tg: { send: async (c, t) => { sent.push(t); }, action: async () => {}, answer: async () => {}, fileBuffer: async () => Buffer.from(''), sendVideo: async () => { video++; } },
      metrics: { hash: () => 'f', log: async () => {}, forget: async () => {} }, draft: modelLike, checkRetryMs: 0, checkBudgetMs: 5000, holdWaitMs: 60,
      safetyCheck: async (t) => (t.includes('Утром я пила чай') ? false : new Promise(() => {})),
      render: async (e, o) => { await r.promise; return { seconds: 1, duration: 24, outPath: o.outPath }; },
    });
    await b.handleUpdate({ message: { chat, text: SAFE } });
    const p = b.handleUpdate({ callback_query: { id: 'q', data: `play:${b.sessions.get(chat.id).draftId}`, message: { chat } } });
    await tick(); await tick();
    b.handleUpdate({ message: { chat, text } });
    r.resolve(); await p;
    assert.equal(video, expectVideo, text);
    if (!expectVideo) assert.equal(sent.filter((t) => t === tryLaterMessage()).length, 1, text);
  }
});

test('п. 4: бытовая форма заканчивает предложение → ролик; с продолжением после запятой или тире → остановка; сигнал в другом предложении → остановка', async () => {
  const pairs = {
    'отравлюсь шавермой': ['Отравлюсь шавермой.', 'Отравлюсь шавермой, а потом таблетками.', 'Отравлюсь шавермой — и всё, хватит.'],
    'без кофе мне не жить': ['Без кофе мне не жить!', 'Без кофе мне не жить, правда не хочу.', 'Без кофе мне не жить — совсем.'],
    'убить готова за кофе': ['Убить готова за кофе…', 'Убить готова за кофе, а себя — хочу убить себя.', 'Убить готова за кофе — и убить себя тоже.'],
  };
  for (const [form, [alone, comma, dash]] of Object.entries(pairs)) {
    assert.equal(assessRisk(alone).level, 'none', form);
    for (const t of [comma, dash]) assert.equal(assessRisk(t).level, 'urgent', t);
    const x = bot();
    await x.say(`${SAFE} ${alone}`);
    await x.play();
    assert.equal(x.c.video, 1, alone);
    const y = bot();
    await y.say(`${SAFE} ${comma}`);
    await y.play();
    assert.equal(y.c.video, 0, comma);
  }
  for (const t of ['Отравлюсь шавермой. Не хочу больше жить.', 'Без кофе мне не жить. Хочу умереть.']) {
    assert.equal(assessRisk(t).level, 'urgent', t);
    const x = bot();
    await x.say(`${SAFE} ${t}`);
    await x.play();
    assert.equal(x.c.video, 0, t); assert.ok(STOP(x.sent.at(-1)), t);
  }
  assert.deepEqual([...HOUSEHOLD_IDIOMS], ['отравлюсь шавермой', 'без кофе мне не жить', 'убить готова за кофе'], 'список не расширен');
});
