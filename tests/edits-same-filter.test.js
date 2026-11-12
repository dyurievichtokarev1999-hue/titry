// Решения владельца 11.11 12:05: правка человека — такой же вход, как рассказ; «угроза не в титрах» сильнее гиперболы;
// местоимение на человека из исключённой угрозы; обычная нехватка у заготовки — та же реплика, что после исключения.
// Только вымышленные короткие примеры.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeDraft, draftRuleBased, groundDraft } from '../server/draft.js';
import { assessRisk, threatErrors, threatPhrase, threatSentences, threatPronounFilter, helpMessage, validateSafeEpisode,
  INSUFFICIENT_TEXT, INSUFFICIENT_MATERIAL, INSUFFICIENT_AFTER_EXCLUSION, EDIT_NOT_IN_TITLES_TEXT, EDIT_NOT_IN_TITLES, editNotInTitlesText } from '../server/safety.js';
import { createBot, TEXT, editExcludedMessages } from '../server/bot.js';
import { EDIT_SEP } from '../engine/episode.js';
import { createApp } from '../server/app.js';
import { rowWordsGrounded, wordsOf } from '../engine/episode.js';

const REPLY = 'Не получилось собрать титры только из твоих слов. Сегодня можно без ролика.';
const SAFE = 'Утром я пила чай. Вечером я пекла пирог.';
const ONE = 'Сегодня утром я долго пила чай.'; // одна фраза — у заготовки одна строка
const URGENT = 'Сегодня всё валится из рук. Я не хочу больше жить.';
const URGENT_CARD = /Сейчас важнее не титры/;
const chat = { id: 88123, type: 'private' };
const manual = (story, o = {}) => makeDraft(story, { ...o, provider: 'manual' });
const fields = (ep) => [ep.title, ep.genre, ep.lead, ...(ep.rows || []).flatMap((r) => [r.role, r.value, r.source]), ep.post?.text, ep.post?.source].join(' | ');
const modelClient = (raw) => ({ beta: { messages: { create: async () => ({ stop_reason: 'end_turn', model: 'm', usage: {}, content: [{ type: 'text', text: JSON.stringify(raw) }] }) } } });
const modelDraft = (over) => ({ title: 'Обычный день', genre: 'тихая драма', mood: 'quiet', grammatical_gender: 'unknown', safety_flag: false, rows: [], post: { text: '', source: '' }, ...over });

function botSetup({ check = () => false, draft = manual } = {}) {
  const sent = []; const events = []; const counters = { render: 0, video: 0, check: 0 }; const checked = [];
  const tg = {
    send: async (c, text, extra = {}) => { sent.push({ text, extra }); }, action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''), sendVideo: async () => { counters.video++; },
  };
  const metrics = { hash: () => 'fictional', log: async (id, event, extra = {}) => { events.push({ event, ...extra }); }, forget: async () => {} };
  const bot = createBot({
    tg, metrics, draft,
    safetyCheck: async (t) => { counters.check++; checked.push(t); return check(t, counters.check); },
    render: async (e, o) => { counters.render++; return { seconds: 1, duration: 24, outPath: o.outPath }; },
  });
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const press = (data) => bot.handleUpdate({ callback_query: { id: 'q', data, message: { chat } } });
  const s = () => bot.sessions.get(chat.id);
  return { bot, sent, events, counters, checked, say, press, s, texts: () => sent.map((m) => m.text) };
}

// Перехват консоли: текст правки не должен уходить в журнал.
async function quiet(fn) {
  const out = []; const orig = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...a) => out.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return out.join('\n');
}

// ── п. 2: фраза из словаря угроз в строке никогда не попадает в титры ───────

test('условие: «Брату — не жить» фильтр остановки не останавливает (concern по словарю, решение 15:05), а правило титров отклоняет', () => {
  const r = assessRisk(`${SAFE}\nБрату не жить`);
  assert.equal(r.level, 'concern', 'не остановка, а concern');
  assert.deepEqual(r.matches, ['threat_phrase']);
  for (const t of ['Брату — не жить', 'Начальнику конец', 'Соседу — достанется', 'Мама — меня убьёт за двойку', 'Брату — убью']) assert.equal(threatPhrase(t), true, t);
  for (const t of ['Утром — пила чай', 'Полку — прибила', 'Рекорд — побил', 'Капец — устала', 'Брат — получит подарок', 'Последний автобус — ушёл']) assert.equal(threatPhrase(t), false, t);
});

test('threatErrors: строка-угроза отклоняется и в рассказе без угрозы, и когда роль и значение безобидны по отдельности', () => {
  const ep = { title: 'Чай', genre: 'драма', lead: 'ты', rows: [{ role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' }, { role: 'Начальнику', value: 'конец', source: 'Начальнику конец' }], post: { text: '', source: '' } };
  assert.deepEqual(threatErrors(`${SAFE}\nНачальнику конец`, ep).map((e) => e.path), ['rows.1']);
  // Гипербола «мама меня убьёт за…» отменяет остановку (рассказ из одних гипербол — concern), но не правило титров.
  const h = 'Мама меня убьёт за опоздание.';
  assert.equal(assessRisk(h).level, 'concern');
  const hep = { ...ep, rows: [{ role: 'Мама', value: 'меня убьёт за опоздание', source: 'Мама меня убьёт за опоздание' }] };
  assert.deepEqual(threatErrors(h, hep).map((e) => e.path), ['rows.0']);
});

test('черновик модели: строка-фраза из словаря угроз отбрасывается даже в рассказе, где фильтр её пропустил', () => {
  const story = `${SAFE} Брату не жить.`;
  const raw = modelDraft({ rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' },
    { role: 'Брату', value: 'не жить', source: 'Брату не жить' },
  ] });
  const g = groundDraft(raw, story);
  assert.doesNotMatch(fields(g.episode), /не жить/);
  assert.equal(g.dropped.length, 1);
});

test('бот: рассказ без угрозы + правка «+ Брату — не жить» → строка не в титрах, короткая реплика и блок concern, без нехватки', async () => {
  const b = botSetup();
  await b.say(SAFE);
  const was = JSON.stringify(b.s().episode);
  const log = await quiet(() => b.say('+ Брату — не жить'));
  assert.equal(JSON.stringify(b.s().episode), was, 'черновик не изменён');
  assert.doesNotMatch(fields(b.s().episode), /жить|Брат/);
  // С 15:05 словарь угроз поднимает уровень до concern: реплика и блок помощи concern одним сообщением.
  assert.equal(b.texts().at(-1), `${EDIT_NOT_IN_TITLES_TEXT}\n\n${helpMessage('concern')}`);
  assert.equal(TEXT.editExcluded, EDIT_NOT_IN_TITLES_TEXT, 'текст в одном месте');
  assert.ok(!b.texts().includes(REPLY)); assert.doesNotMatch(b.texts().join('\n'), URGENT_CARD);
  assert.doesNotMatch(log + JSON.stringify(b.events), /жить|Брат/, 'текста правки нет в журнале и метриках');
  assert.deepEqual(b.events.at(-1), { event: 'edit_excluded', level: 'concern' });
  // Черновик без этой строки собирается; отдельная проверка видит и правку (контекст рассказа + правка).
  await b.press(`play:${b.s().draftId}`);
  assert.equal(b.counters.video, 1);
  assert.match(b.checked.at(-1), /Брату не жить/);
});

test('реплика «не берём» — короткая и нейтральная: без морали, без позитива, без восклицаний', () => {
  assert.ok(EDIT_NOT_IN_TITLES_TEXT.length <= 60);
  assert.doesNotMatch(EDIT_NOT_IN_TITLES_TEXT, /!|нельзя|плохо|должн|всё будет|хорош|спасибо|понимаем/i);
  assert.deepEqual(editExcludedMessages(false), [EDIT_NOT_IN_TITLES_TEXT]);
  assert.deepEqual(editExcludedMessages(true), [`${EDIT_NOT_IN_TITLES_TEXT}\n\n${helpMessage('concern')}`]);
});

// ── п. 1: правка проходит тот же фильтр остановки в контексте всего рассказа ──

test('бот: правка с concern → строка не берётся, реплика и блок помощи concern одним сообщением, без нехватки', async () => {
  for (const edit of ['+ Брат — хочу его ударить', '2: хочу его ударить', 'после: хочу его ударить']) {
    const b = botSetup();
    await b.say(SAFE);
    const n = b.sent.length;
    const was = JSON.stringify(b.s().episode);
    const log = await quiet(() => b.say(edit));
    const after = b.sent.slice(n);
    assert.equal(after.length, 1, edit);
    const field = edit.startsWith('после') ? 'post' : 'rows.0';
    assert.equal(after[0].text, `${editNotInTitlesText(field)}\n\n${helpMessage('concern')}`, edit);
    assert.equal(JSON.stringify(b.s().episode), was, `${edit}: черновик прежний`);
    assert.ok(!b.texts().includes(REPLY), edit); assert.doesNotMatch(b.texts().join('\n'), URGENT_CARD, edit);
    assert.doesNotMatch(log + JSON.stringify(b.events), /удар/, `${edit}: текста правки нет в журнале и метриках`);
  }
});

test('бот: правка с urgent → остановка как у рассказа: карточка urgent, черновик уничтожен, без нехватки', async () => {
  const b = botSetup();
  await b.say(SAFE);
  const old = b.s().draftId;
  const log = await quiet(() => b.say('2: не хочу больше жить'));
  assert.equal(b.texts().at(-1), helpMessage('urgent'));
  assert.equal(b.s().episode, null);
  assert.ok(!b.texts().includes(REPLY));
  assert.deepEqual(b.events.at(-1), { event: 'safety', level: 'urgent', at: 'edit' });
  assert.doesNotMatch(log + JSON.stringify(b.events), /жить/);
  await b.press(`play:${old}`);
  assert.match(b.texts().at(-1), URGENT_CARD); assert.equal(b.counters.render, 0);
  // Тот же рассказ снова — остановка (рассказ запомнен как запрещённый).
  await b.say(SAFE);
  assert.match(b.texts().at(-1), URGENT_CARD);
});

test('бот: правка оценивается в контексте всего рассказа — сама по себе concern, вместе с рассказом urgent', async () => {
  const story = 'Утром я наточила нож. Вечером я пекла пирог.';
  assert.equal(assessRisk(story).level, 'none');
  assert.equal(assessRisk('Брат убью его').level, 'concern');
  const b = botSetup();
  await b.say(story);
  assert.ok(b.s().episode);
  await b.say('+ Брат — убью его');
  assert.equal(b.texts().at(-1), helpMessage('urgent'));
  assert.equal(b.s().episode, null);
});

test('бот: безобидная правка в рассказе с concern проходит как обычно', async () => {
  const MIX = 'Я злюсь на брата и хочу его ударить. Утром я пила чай. Вечером я пекла пирог.';
  const b = botSetup();
  await b.say(MIX);
  await b.say('+ Вечером — гуляла в парке');
  assert.ok(b.s().episode.rows.some((r) => r.role === 'Вечером' && r.value === 'гуляла в парке'));
  assert.notEqual(b.texts().at(-1), EDIT_NOT_IN_TITLES_TEXT);
});

test('бот: слова строки из правки — только из текста этой правки (дословность PR 13)', async () => {
  const b = botSetup();
  await b.say(SAFE);
  await b.say('2: днём я гуляла в парке');
  const row = b.s().episode.rows[1];
  const own = new Set(wordsOf('днём я гуляла в парке'));
  for (const w of wordsOf(`${row.role} ${row.value}`)) assert.ok(own.has(w), `«${w}» из правки`);
  assert.ok(rowWordsGrounded(row, 'днём я гуляла в парке'));
});

// На голове PR 13 225f6701 правка «N: текст» получала ⚠ «стоит с другим служебным словом»; поправлено в 7595d8d9.
test('бот: правка «2: днём я гуляла в парке» к безопасному рассказу проходит проверку черновика', async () => {
  const b = botSetup();
  await b.say(SAFE);
  await b.say('2: днём я гуляла в парке');
  assert.equal(b.s().validation.ok, true, JSON.stringify(b.s().validation.errors));
});

// ── п. 3: местоимение на человека из исключённой угрозы ─────────────────────

test('заготовка: фраза с местоимением на человека из угрозы отбрасывается; другие люди и рассказы без угрозы — нет', () => {
  const st = 'Я бы убил брата. Он опять шумел. Утром я пила чай. Вечером я пекла пирог.';
  assert.equal(assessRisk(st).level, 'concern');
  const f = threatPronounFilter(st);
  assert.equal(f('Он опять шумел'), true);
  assert.equal(f('Утром я пила чай'), false);
  const r = draftRuleBased(st);
  assert.doesNotMatch(fields(r.episode), /шумел/);
  assert.equal(r.episode.rows.length, 2);
  // Местоимение в предложении с угрозой («Я бы его убил») — тоже цель угрозы.
  assert.equal(threatPronounFilter('Брат опять кричал. Я бы его убил. Он потом ушёл.')('Он потом ушёл'), true);
  // Ближайший человек — не из угрозы, род совпадает: строка остаётся.
  assert.equal(threatPronounFilter('Я бы убил брата. Мама позвонила. Она плакала.')('Она плакала'), false);
  // Род не совпадает («мама … он»): «он» — брат из угрозы.
  assert.equal(threatPronounFilter('Я бы убил брата. Мама сказала, что он извинился.')('Мама сказала, что он извинился'), true);
  // Рассказ без угрозы: местоимения не трогаются.
  assert.equal(threatPronounFilter('Утром я пила чай. Он позвонил.')('Он позвонил'), false);
});

test('заготовка: после отбрасывания такой строки не хватает строк → путь нехватки после исключения', async () => {
  const st = 'Я бы убил брата. Он опять кричал. Утром я пила чай.';
  const r = await manual(st);
  assert.equal(r.insufficient, true);
  assert.equal(r.code, INSUFFICIENT_AFTER_EXCLUSION);
  assert.equal(r.episode, null);
});

// ── п. 4: обычная нехватка у заготовки ──────────────────────────────────────

test('(а) makeDraft: нехватка у заготовки без исключений → insufficient_material, без черновика и без ⚠', async () => {
  assert.equal(draftRuleBased(ONE).insufficient, true);
  const r = await manual(ONE);
  assert.equal(r.insufficient, true);
  assert.equal(r.code, INSUFFICIENT_MATERIAL);
  assert.equal(r.episode, null);
  assert.deepEqual(Object.keys(r).sort(), ['code', 'episode', 'insufficient', 'provider', 'risk']);
  // Две строки — обычный черновик.
  const ok = await manual(SAFE);
  assert.ok(ok.episode); assert.ok(!ok.insufficient);
});

test('(а) бот: нехватка у заготовки → только реплика нехватки; ни черновика с ⚠, ни ролика; метрика — только код', async () => {
  const b = botSetup();
  await b.say(ONE);
  const after = b.sent.slice(b.texts().indexOf(TEXT.working) + 1).map((m) => m.text);
  assert.deepEqual(after, [REPLY]);
  assert.doesNotMatch(b.texts().join('\n'), /Нужно хотя бы|⚠/);
  assert.equal(b.s().episode, null);
  assert.deepEqual(b.events, [{ event: INSUFFICIENT_MATERIAL }]);
  for (let n = 0; n <= 2; n++) await b.press(`play:${n}`);
  assert.equal(b.counters.render, 0); assert.equal(b.counters.video, 0);
});

async function withApp(opts, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-edits-'));
  const counters = { render: 0 };
  const server = createApp({
    dataDir, draft: opts.draft || manual, safetyCheck: async () => false, hasKey: () => true,
    render: async (e, o) => { counters.render++; return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ post, counters }); } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('(а) монтажная: нехватка у заготовки → 422 { kind: insufficient, error: реплика } и ничего больше', async () => {
  await withApp({}, async ({ post, counters }) => {
    const r = await post('/api/draft', { story: ONE });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body, { kind: 'insufficient', error: REPLY });
    assert.equal(counters.render, 0);
  });
});

test('(б) остановленный фильтром текст → только остановка, реплики нехватки нет (бот и монтажная)', async () => {
  const b = botSetup();
  await b.say(URGENT);
  assert.match(b.texts().at(-1), URGENT_CARD);
  assert.ok(!b.texts().includes(REPLY));
  await withApp({}, async ({ post }) => {
    const r = await post('/api/draft', { story: URGENT });
    assert.equal(r.body.kind, 'safety');
    assert.ok(!JSON.stringify(r.body).includes(REPLY));
  });
});

test('(в) одна и та же реплика для модели и заготовки', async () => {
  assert.equal(INSUFFICIENT_TEXT, REPLY);
  const fewRows = modelDraft({ rows: [{ role: 'Утром', value: 'долго пила чай', source: 'утром я долго пила чай' }] });
  const viaModel = (story, o) => makeDraft(story, { ...o, provider: 'claude', client: modelClient(fewRows) });
  const rm = await viaModel(ONE, {});
  const rr = await manual(ONE);
  assert.equal(rm.insufficient, true); assert.equal(rr.insufficient, true);
  assert.equal(rm.code, rr.code);
  const bm = botSetup({ draft: viaModel });
  const br = botSetup();
  await bm.say(ONE); await br.say(ONE);
  assert.equal(bm.texts().at(-1), REPLY);
  assert.equal(br.texts().at(-1), REPLY);
  await withApp({ draft: viaModel }, async ({ post }) => {
    const r = await post('/api/draft', { story: ONE });
    assert.deepEqual(r.body, { kind: 'insufficient', error: REPLY });
  });
});

test('validateSafeEpisode по-прежнему пропускает обычный черновик из двух строк', async () => {
  const r = await manual(SAFE);
  assert.equal(validateSafeEpisode(r.episode, SAFE).ok, true);
});


// Рассказ ничего не теряет из-за правила «угроза не в титрах»: нет исключённых частей, ни одна фраза не отбрасывается
// словарём или местоимениями, нехватка (если она есть) — обычная, не после исключения. Сколько строк соберёт заготовка,
// решает белый список формы фразы PR 13 — это проверяется отдельно.
async function nothingExcluded(st) {
  assert.deepEqual(threatSentences(st), [], st);
  const pron = threatPronounFilter(st);
  for (const x of st.split(/(?<=[.!?…])\s+/)) { assert.equal(threatPhrase(x), false, x); assert.equal(pron(x), false, x); }
  assert.equal(assessRisk(st).level, 'none', st);
  const r = await manual(st);
  assert.notEqual(r.code, INSUFFICIENT_AFTER_EXCLUSION, st);
  if (r.episode) assert.equal(validateSafeEpisode(r.episode, st).ok, true, st);
}

// ── Замечания независимого разбора 940f41cc ─────────────────────────────────

test('разбор, блокер: текст правки проходит фильтр и при ошибке номера строки или лимита строк', async () => {
  const b = botSetup();
  await b.say(SAFE);
  await b.say('9: я не хочу больше жить');
  assert.equal(b.texts().at(-1), helpMessage('urgent'));
  assert.equal(b.s().episode, null);
  const full = botSetup();
  await full.say('Утром я пила чай. Днём я пекла пирог. Вечером я гуляла в парке. Ночью я смотрела кино. Потом я мыла посуду. Затем я писала письмо.');
  while (full.s().episode.rows.length < 6) await full.say(`+ Строка${full.s().episode.rows.length} — тихий вечер`);
  await full.say('+ Мысль — не хочу больше жить');
  assert.equal(full.texts().at(-1), helpMessage('urgent'));
  await full.press(`play:${full.s().draftId}`);
  assert.equal(full.counters.video, 0);
});

test('разбор, важно: один вердикт на правку — нет «черновик на месте», а потом остановки на «Смотреть»', async () => {
  for (const edit of ['+ Брата — я бы убила', '+ Брат — хочу его ударить', '+ Соседу — жить не дам']) {
    const b = botSetup();
    await b.say(SAFE);
    await b.say(edit);
    if (b.s().episode) await b.press(`play:${b.s().draftId}`);
    assert.ok(!b.events.some((e) => e.event === 'safety' && e.at === 'render'), edit);
    const stopped = b.events.some((e) => e.event === 'safety' && e.at === 'edit');
    assert.equal(b.counters.video, stopped ? 0 : 1, edit);
    if (!stopped) assert.ok(b.texts().includes(EDIT_NOT_IN_TITLES_TEXT) || b.texts().some((t) => t.startsWith(EDIT_NOT_IN_TITLES_TEXT)), edit);
  }
});

test('разбор, важно: словарь не задевает бытовые фразы на уровне рассказа', async () => {
  for (const st of [
    'Брат пожалеет, что не пошёл с нами в кино. Мы смотрели комедию. Потом ели пиццу.',
    'Маме достанется последний кусок торта. Утром я пила чай. Вечером я пекла пирог.',
    'Конец урока, учитель отпустил нас раньше. Утром я пила чай. Вечером я пекла пирог.',
    'Телефон сдохнет к обеду, зарядку забыла. Утром я пила чай. Вечером я пекла пирог.',
    'Подруга пожалеет, что не пришла. Утром я пила чай. Вечером я пекла пирог.',
  ]) await nothingExcluded(st);
  for (const t of ['Маме — достанется торт', 'Телефон — сдохнет к вечеру', 'Конец урока, учитель отпустил нас']) assert.equal(threatPhrase(t), false, t);
});

test('разбор, важно: перестановки и синонимы угрозы ловятся', async () => {
  // «недолго осталось» в словарь не входит: так чаще говорят о горе («Бабушке осталось недолго»), третий разбор.
  assert.equal(threatPhrase('Брату — недолго осталось'), false);
  for (const t of ['Брату — жить не дам', 'Брату — капут', 'Брату — кирдык', 'Мама — меня придушит за вазу', 'Мама — меня закопает за вазу']) assert.equal(threatPhrase(t), true, t);
  const b = botSetup();
  await b.say(SAFE);
  await b.say('+ Брату — жить не дам');
  assert.doesNotMatch(fields(b.s()?.episode || {}), /жить не дам/);
  assert.equal(b.counters.video, 0);
});

test('разбор, мелочь: два подходящих по роду человека, один из угрозы, — местоимение неясно, строка отбрасывается', () => {
  assert.equal(threatPronounFilter('Я бы убил брата. Папа пришёл вечером. Он опять кричал.')('Он опять кричал'), true);
  assert.equal(threatPronounFilter('Я бы убил брата. Мама позвонила. Она плакала.')('Она плакала'), false);
});

test('разбор, мелочь: правка с местоимением на человека из угрозы в рассказе с concern не идёт в титры', async () => {
  const b = botSetup();
  await b.say('Я бы убила брата. Утром я пила чай. Вечером я пекла пирог.');
  assert.ok(b.s().episode);
  await b.say('+ Он — опять кричал');
  assert.ok(!b.s().episode.rows.some((r) => /кричал/.test(r.value)));
  assert.equal(b.texts().at(-1), EDIT_NOT_IN_TITLES_TEXT);
});

test('разбор, мелочь: деление длинного ответа «не берём» пишет в журнал только код', () => {
  const logs = [];
  // Блок помощи сам ≤ 4096, вместе с репликой — длиннее.
  const base = helpMessage('concern', { contacts: [{ label: '', phone: '112' }] }).length;
  const long = { contacts: [{ label: 'Ж'.repeat(4090 - base), phone: '112' }] };
  assert.ok(helpMessage('concern', long).length <= 4096);
  const parts = editExcludedMessages(true, { help: long, log: (stage, e) => logs.push({ stage, ...e }) });
  assert.deepEqual(parts, [helpMessage('concern', long), EDIT_NOT_IN_TITLES_TEXT]);
  assert.deepEqual(logs, [{ stage: 'edit', code: 'message_too_long' }]);
});

// ── Замечания повторного разбора 08ead472 ───────────────────────────────────

const THREAT_ROWS = ['Брату — скоро конец', 'Брату — теперь конец', 'Брату — точно конец', 'Брату — полный конец', 'Брату — конец будет',
  'Брату — точно не поздоровится', 'Брат — не жилец', 'Брат — покойник', 'Брат больше не проснётся', 'Брат — сдохнет скоро', 'Сдохни, брат',
  'Брату гроб', 'Брата закопаю', 'Я его закопаю', 'Тебе — конец'];
const EVERYDAY = ['Брату осталось недолго до отпуска', 'У мамы телефон сдохнет скоро', 'Маме недолго осталось до пенсии', 'Брат сказал хана компу',
  'Детям достанется от бабушки пирог', 'Сыну достанется по наследству', 'Подруге крышка от банки', 'Отпуск у коллеги — конец',
  'Маме осталось жить в общаге месяц', 'Сессия — меня прикончит', 'Мама закопала тюльпаны', 'Брат замочил бельё'];

test('повторный разбор, блокер 2: наречие, именительный падеж и синонимы не обходят правило', () => {
  for (const t of THREAT_ROWS) assert.equal(threatPhrase(t), true, t);
});

test('повторный разбор, блокер 1: бытовые фразы не считаются угрозой; рассказы с ними не теряют строк', async () => {
  for (const t of EVERYDAY) assert.equal(threatPhrase(t), false, t);
  for (const st of [
    'Брату осталось недолго до отпуска. Он купил билеты на море. Он собрал чемодан.',
    'Утром сломался чайник. У мамы телефон сдохнет скоро. Она весь день искала зарядку.',
    'Маме недолго осталось до пенсии. Мама купила календарь. Вечером мы пили чай.',
    'Сессия меня прикончит. Утром пила кофе. Вечером читала конспект.',
  ]) await nothingExcluded(st);
});

test('повторный разбор: в боте «+ Брату — скоро конец» и «+ Брат — не жилец» не идут в ролик; бытовая правка идёт', async () => {
  for (const edit of ['+ Брату — скоро конец', '+ Брат — не жилец']) {
    const b = botSetup();
    await b.say(SAFE);
    await b.say(edit);
    assert.ok(b.texts().at(-1).startsWith(EDIT_NOT_IN_TITLES_TEXT), edit);
    assert.doesNotMatch(fields(b.s().episode), /конец|жилец/, edit);
  }
  const ok = botSetup();
  await ok.say(SAFE);
  await ok.say('+ Брату — осталось недолго до отпуска');
  assert.ok(ok.s().episode.rows.some((r) => /отпуска/.test(r.value)));
});

test('повторный разбор, важно: «нём», люди вне прежнего списка (тренер, бабушка), черновик модели — местоимения', () => {
  assert.equal(threatPronounFilter('Утром пила чай. Я бы убил брата. Весь вечер думала о нём.')('Весь вечер думала о нём'), true);
  assert.equal(threatPronounFilter('Утром пила чай. Тренеру не жить. Он опять кричал на всех.')('Он опять кричал на всех'), true);
  assert.equal(threatPronounFilter('Утром пила чай. Бабушке не жить. Она опять ворчала.')('Она опять ворчала'), true);
  const st = 'Я бы убил брата. Он опять шумел. Утром я пила чай. Вечером я пекла пирог.';
  const g = groundDraft(modelDraft({ rows: [
    { role: 'Он', value: 'опять шумел', source: 'Он опять шумел' },
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' },
  ] }), st);
  assert.doesNotMatch(fields(g.episode), /шумел/);
});

test('повторный разбор: после исключённой правки отдельная проверка видит её текст — «опасно» даёт остановку', async () => {
  const b = botSetup({ check: (t) => /не жить/.test(t) });
  await b.say(SAFE);
  await b.say('+ Брату — не жить');
  await b.press(`play:${b.s().draftId}`);
  assert.equal(b.counters.video, 0);
  assert.match(b.texts().at(-1), URGENT_CARD);
});

// ── Замечания третьего разбора ──────────────────────────────────────────────

const EVERYDAY_3 = ['Брат не проснётся до обеда', 'Малыш уснул, и он не проснётся до утра', 'Последний кусок торта достанется маме',
  'Приз достанется брату', 'Всё наследство достанется сыну', 'Соседи жить не дадут со своим ремонтом', 'Начальник жить не даст',
  'Бабушке осталось недолго', 'Бабушка-покойница пекла пироги', 'Дедушка покойник любил рыбалку', 'Класс, теперь мне хана',
  'Ноуту хана, брат', 'Брат не доживёт до зарплаты'];

test('третий разбор, блокер: бытовые фразы и горе не считаются угрозой; рассказ с ними собирается', async () => {
  for (const t of EVERYDAY_3) assert.equal(threatPhrase(t), false, t);
  for (const st of [
    'В школе был конкурс рисунков. Главный приз достанется брату. Он рисовал весь месяц. Я им горжусь.',
    'Соседи жить не дадут со своим ремонтом. Они сверлят с утра. Вечером я пекла пирог.',
    'Последний кусок торта достанется маме. Она его заслужила. Утром я пила чай.',
  ]) await nothingExcluded(st);
  const b = botSetup();
  await b.say(SAFE);
  await b.say('+ Приз — достанется брату');
  assert.ok(b.s().episode.rows.some((r) => /брату/.test(r.value)));
});

test('третий разбор, важно: пожелания смерти ловятся', () => {
  for (const t of ['Брат, чтоб ты сдох', 'Брату пусть сдохнет', 'Желаю брату сдохнуть', 'Чтоб он сдох', 'Сдохни, брат']) assert.equal(threatPhrase(t), true, t);
});

test('третий разбор, важно: «меня придушит» не попадает ни в пост, ни в название; заготовка не берёт такую фразу', async () => {
  for (const edit of ['после: Мама меня придушит за вазу', 'название: Мама меня придушит']) {
    const b = botSetup();
    await b.say(SAFE);
    await b.say(edit);
    assert.doesNotMatch(fields(b.s()?.episode || {}), /придушит/, edit);
  }
  for (const st of ['Утром я пила чай. Вечером я пекла пирог. Днём гуляла в парке. Мама меня придушит за вазу.',
    'Мама меня придушит за вазу. Утром я пила чай. Вечером я пекла пирог. Днём гуляла в парке.']) {
    const r = await manual(st);
    assert.ok(r.episode, st);
    assert.doesNotMatch(fields(r.episode), /придушит/, st);
    assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
  }
  const g = groundDraft(modelDraft({ rows: [{ role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' }, { role: 'Вечером', value: 'пекла пирог', source: 'Вечером я пекла пирог' }],
    post: { text: 'Мама меня придушит за вазу', source: 'Мама меня придушит за вазу' } }), `${SAFE} Мама меня придушит за вазу.`);
  assert.equal(g.episode.post.text, '');
});

test('третий разбор, мелочь: фильтр местоимений сравнивает фразы по словам, а не по подстроке', () => {
  const f = threatPronounFilter('Я бы убил брата. Он сидел дома. Утром я пила чай.');
  assert.equal(f('Он сидел дома'), true);
  assert.equal(f('дома'), false);
});

// ── Замечания четвёртого разбора ────────────────────────────────────────────

test('четвёртый разбор: бытовое «он сдохнет» о технике, стирка, сон не размножаются через местоимения', async () => {
  for (const [st, keep] of [
    ['Телефон совсем старый, он скоро сдохнет. Муж пришёл поздно. Он принёс торт.', 'Он принёс торт.'],
    ['Батарейка в часах старая, она скоро сдохнет. Мама пришла поздно. Она принесла пирог. Мы пили чай.', 'Она принесла пирог.'],
    ['Сегодня стирка. Замочу его футболку на ночь. Сын пришёл с тренировки. Он устал.', 'Он устал.'],
    ['Малыш уснул в машине. Он не проснётся, если не шуметь. Дома он проснулся и смеялся.', 'Дома он проснулся и смеялся.'],
    ['Принтер опять зажевал бумагу, чтоб он сдох. Начальник пришёл в обед. Он принёс пиццу.', 'Он принёс пиццу.'],
  ]) {
    // Фраза с «он/она» не отбрасывается правилом местоимений (строку из неё может не взять белый список PR 13 — это отдельно).
    assert.equal(threatPronounFilter(st)(keep), false, st);
    // И уровень риска бытового рассказа — none (пятый разбор).
    assert.equal(assessRisk(st).level, 'none', st);
  }
  // Угроза человеку по-прежнему распространяется: «Брат … Я бы его убил. Он …».
  assert.equal(threatPronounFilter('Брат опять кричал. Я бы его убил. Он потом ушёл.')('Он потом ушёл'), true);
});

test('четвёртый разбор: человек в той же строке правки — антецедент; «ноги переломаю» при человеке — угроза', async () => {
  const b = botSetup();
  await b.say(SAFE);
  await b.say('+ Брату — не жить');
  await b.say('+ Муж — он принёс торт');
  assert.ok(b.s().episode.rows.some((r) => /торт/.test(r.value)));
  for (const t of ['Брату — ноги переломаю', 'Брат — ноги переломаю']) assert.equal(threatPhrase(t), true, t);
  assert.equal(threatPhrase('Вечером — замочу его рубашку'), false);
});

test('четвёртый разбор: нехватка, когда фразу исключило только правило титров, — код insufficient_after_exclusion', async () => {
  const r = await manual('Тренер меня порвёт на тренировке. Утром я пила чай.');
  assert.equal(r.insufficient, true);
  assert.equal(r.code, INSUFFICIENT_AFTER_EXCLUSION);
});

// ── Ответы владельца 11.11 15:05 ────────────────────────────────────────────

test('владелец 15:05, п. 1: остановка после «не берём» — последним человек видит экран остановки, ролика нет, больше ничего', async () => {
  const b = botSetup({ check: (t) => /не жить/.test(t) });
  await b.say(SAFE);
  await b.say('+ Брату — не жить');
  const at = b.texts().length;
  assert.ok(b.texts()[at - 1].startsWith(EDIT_NOT_IN_TITLES.row), 'сначала «не берём»');
  await b.press(`play:${b.s().draftId}`);
  const after = b.sent.slice(at);
  assert.deepEqual(after.map((m) => m.text), [helpMessage('urgent')], 'после «не берём» — только экран остановки');
  assert.equal(after[0].extra.reply_markup, undefined, 'без кнопок');
  assert.equal(b.counters.video, 0); assert.equal(b.counters.render, 0);
  // Ничего больше не уходит: кнопки и повторные нажатия дают тот же экран остановки, ролика нет.
  await b.press(`play:${b.s().draftId}`);
  await b.press(`mood:${b.s().draftId}`);
  for (const m of b.sent.slice(at)) assert.equal(m.text, helpMessage('urgent'));
  assert.equal(b.counters.video, 0);
  // Ключ запрета — в памяти и в хранилище шлюза (HMAC), текста правки нет в метриках.
  assert.doesNotMatch(JSON.stringify(b.events), /жить|Брат/);
});

test('владелец 15:05, п. 4: реплика «не берём» — шаблон с названием поля, тексты в одном месте', async () => {
  assert.deepEqual(Object.keys(EDIT_NOT_IN_TITLES).sort(), ['genre', 'lead', 'post', 'row', 'title']);
  assert.equal(editNotInTitlesText('rows.3'), EDIT_NOT_IN_TITLES.row);
  assert.equal(EDIT_NOT_IN_TITLES.row, EDIT_NOT_IN_TITLES_TEXT);
  for (const t of Object.values(EDIT_NOT_IN_TITLES)) {
    assert.match(t, /не берём\.$/); assert.ok(t.length <= 60);
    assert.doesNotMatch(t, /!|нельзя|плохо|должн|хорош|спасибо/i);
  }
  for (const [edit, field] of [['название: Брату не жить', 'title'], ['жанр: Брату конец', 'genre'], ['в главной роли: Брату не жить', 'lead'], ['после: Брату не жить', 'post'], ['+ Брату — не жить', 'row']]) {
    const b = botSetup();
    await b.say(SAFE);
    await b.say(edit);
    assert.ok(b.texts().at(-1).startsWith(EDIT_NOT_IN_TITLES[field]), `${edit}: ${b.texts().at(-1).slice(0, 40)}`);
  }
});

// ── Решение владельца 11.11 15:05: assessRisk поднимает уровень по словарю угроз ──

test('assessRisk: фраза из словаря угроз поднимает none до concern; бытовые фразы и уровни других правил не меняются', () => {
  for (const t of ['Брата прикончу.', 'Брат — покойник.', 'Ноги переломаю соседу.', 'Зарежу.', 'Пристрелю!', 'Иди сдохни.', `${SAFE} Брату не жить.`]) {
    const r = assessRisk(t);
    assert.equal(r.level, 'concern', t); assert.deepEqual(r.matches, ['threat_phrase'], t);
  }
  for (const t of [SAFE, 'Прибью полку завтра.', 'Убью время до вечера.', 'Сессия меня прикончит.', 'Приз достанется брату.', 'Брат не проснётся до обеда.', ...EVERYDAY, ...EVERYDAY_3]) {
    assert.equal(assessRisk(t).level, 'none', t);
  }
  // Монотонность: urgent и concern других правил остаются как были.
  assert.equal(assessRisk(URGENT).level, 'urgent');
  assert.equal(assessRisk('Завтра зарежу соседа. Брату не жить.').level, 'urgent');
  assert.equal(assessRisk('Мама меня убьёт за опоздание.').level, 'concern');
});

test('assessRisk: рассказ со словарной угрозой даёт черновик с блоком помощи concern, фраза не в титрах', async () => {
  const st = 'Утром я пила чай. Вечером я пекла пирог. Брату не жить.';
  const b = botSetup();
  await b.say(st);
  assert.ok(b.texts().includes(helpMessage('concern')));
  assert.ok(b.s().episode);
  assert.doesNotMatch(fields(b.s().episode), /не жить/);
});

// ── Пятый разбор: местоимения в середине фразы и про вещи не поднимают уровень ──

test('пятый разбор: «кому достанется» с местоимением в середине, «он/ей» про вещь, «не проснётся, если» — none', () => {
  for (const t of ['Последний кусок торта ему достанется.', 'Самое вкусное ей достанется.', 'Приз тебе достанется.', 'Пирог им достанется.',
    'Мне кажется, премия ей достанется.', 'Телефон совсем старый, он скоро сдохнет.', 'Кофемашина старая, ей конец.', 'Свитер порвался, ему хана.',
    'Лето кончилось, ему конец.', 'Цветок завял, он не жилец.', 'Принтер опять зажевал бумагу, чтоб он сдох.',
    'Малыш спит, он не проснётся, если не шуметь.', 'Брат не проснётся, если не включить будильник.', 'Ему достанется.']) assert.equal(assessRisk(t).level, 'none', t);
  for (const t of ['А тебе достанется!', 'Тебе конец.', 'Брат опять орал. Ему конец.', 'Брат орал. Ему достанется, если не вернёт деньги.',
    'Брат орал. Скоро ему конец.', 'Брат опять орал. Чтоб он сдох.', 'Брат орал. Я его закопаю.', 'Брат, чтоб ты сдох.', 'Брату пусть сдохнет.', 'Желаю брату сдохнуть.']) assert.equal(assessRisk(t).level, 'concern', t);
  // В титрах местоимение-угроза по-прежнему не берётся, без контекста.
  for (const t of ['Ему — конец', 'Он — не жилец', 'Тебе — конец']) assert.equal(threatPhrase(t), true, t);
});

test('пятый разбор: реплика «не берём» — неизвестный путь даёт текст строки', () => {
  assert.equal(editNotInTitlesText('constructor'), EDIT_NOT_IN_TITLES.row);
  assert.equal(editNotInTitlesText('title'), EDIT_NOT_IN_TITLES.title);
});

// ── Шестой разбор: местоимение в части через запятую, контекст правки через EDIT_SEP, «переломаю ноги» ──

test('шестой разбор: «человек сделал что-то, ему конец» — concern в любой пунктуации; про вещи — none', () => {
  for (const t of ['Начальник наорал, ему не жить.', 'Сосед опять залил нас, ему конец.', 'Сосед опять шумел, он не жилец.', 'Брат, тебе конец.',
    'Мама, ты покойник.', 'Сосед опять шумел, ему конец.', 'Сосед опять шумел. Ему конец.']) assert.equal(assessRisk(t).level, 'concern', t);
  for (const t of ['Телефон совсем старый, он скоро сдохнет.', 'Свитер порвался, ему хана.', 'Последний кусок торта ему достанется.', 'Торт вкусный, прикончу его завтра.'])
    assert.equal(assessRisk(t).level, 'none', t);
});

test('шестой разбор: «переломаю ноги» в любом порядке при человеке; себе и вещам — нет', () => {
  for (const t of ['Переломаю соседу ноги.', 'Переломаю ноги брату.', 'Ноги брату переломаю.', 'Сосед опять залил нас. Переломаю ему ноги.',
    'Ноги тебе переломаю.', 'Сосед опять залил нас. Ноги ему переломаю.']) assert.equal(assessRisk(t).level, 'concern', t);
  for (const t of ['Переломаю себе ноги на этом льду.', 'Сломаю ногу, если пойду на каток.', 'Я сломаю маме кофемолку.', 'Мы с братом чуть не переломали ноги на горке.'])
    assert.equal(assessRisk(t).level, 'none', t);
});

test('шестой разбор: правка через EDIT_SEP не теряет контекст рассказа — «после: Ему конец.» даёт блок помощи', async () => {
  const st = 'Утром я пила чай. Вечером я пекла пирог. Сосед опять шумел всю ночь.';
  assert.equal(assessRisk(`${st}${EDIT_SEP}Ему конец.`).level, 'concern');
  const b = botSetup();
  await b.say(st);
  assert.ok(b.s().episode);
  await b.say('после: Ему конец.');
  assert.equal(b.texts().at(-1), `${EDIT_NOT_IN_TITLES.post}\n\n${helpMessage('concern')}`);
  assert.deepEqual(b.events.at(-1), { event: 'edit_excluded', level: 'concern' });
});

test('слияние PR 13 (joinEdits): правка — продолжение рассказа для фильтра: «…я хочу» + правка «1: умереть» — остановка', async () => {
  const b = botSetup();
  await b.say('Утром я пила чай. Вечером я пекла пирог. Честно, я хочу');
  if (!b.s().episode) return; // заготовка не собрала черновик — правки не к чему применять
  await b.say('1: умереть');
  assert.equal(b.texts().at(-1), helpMessage('urgent'));
  assert.equal(b.s().episode, null);
  assert.equal(b.counters.video, 0);
});

// ── Решение владельца 12.11 11:05, п. 2: прошедшее время насилия над человеком — concern ──

test('12.11, п. 2: «Я закопала соседа», «Я переломала соседу ноги» — concern; «закопала семена», «переломала ноготь», «убила вечер» — нет', () => {
  for (const t of ['Я закопала соседа.', 'Я переломала соседу ноги.', 'Я прикончила соседа.', 'Вчера я закопала брата.', 'Сосед опять шумел. Я закопала его.',
    'Переломала брату ногу.']) assert.equal(assessRisk(t).level, 'concern', t);
  for (const t of ['Я закопала семена.', 'Я переломала ноготь.', 'Я убила вечер на сериал.', 'Мы закопали сына в песок на пляже.', 'Я прикончила торт.',
    'Брат переломал ногу на катке.', 'Мама закопала тюльпаны.', 'Мы с братом чуть не переломали ноги на горке.']) assert.equal(assessRisk(t).level, 'none', t);
  // В титры такая строка тоже не берётся.
  assert.equal(threatPhrase('Вечером — я закопала соседа'), true);
});
