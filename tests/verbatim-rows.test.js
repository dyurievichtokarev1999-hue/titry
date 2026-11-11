// Правило «слова строки — только из её цитаты» (владелец вместе с редактором, ответ 11.11 09:05).
// Все тексты — вымышленные (tests/fixtures/verbatim-rows.json и examples/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EDIT_SEP, LIMITS, joinEdits, plainPhrase, rowWordProblems, rowWordsGrounded, sanitizeEpisode, validateEpisode } from '../engine/episode.js';
import { assessEpisodeRisk } from '../server/safety.js';
import { pairFromSentence } from '../server/draft.js';
import { validateSafeEpisode } from '../server/safety.js';
import { draftRuleBased, draftWithClaude, groundDraft, makeDraft, SYSTEM_PROMPT } from '../server/draft.js';
import { applyEdit, createBot, draftMessage, makeMetrics, parseEdit } from '../server/bot.js';
import { createApp } from '../server/app.js';

const fx = JSON.parse(await fs.readFile(new URL('./fixtures/verbatim-rows.json', import.meta.url), 'utf8'));
const STORY = fx.controls.story;

/** Эпизод из одной проверяемой строки и одной заведомо правильной. */
const episodeWith = (row) => sanitizeEpisode({
  date: '2026-11-11', title: 'Чай и яблоко', genre: 'камерное кино', mood: 'quiet', music: 'quiet',
  rows: [row, { role: 'Ёжик', value: 'ел яблоко', source: 'Ёжик ел яблоко' }],
});

test('контроли редактора: «Утро — чай», «Утренний — чай», «горячий» отклоняются; «Утром — чай» принимается', () => {
  for (const { case: name, row, path: p } of fx.controls.reject) {
    const v = validateEpisode(episodeWith(row), STORY);
    assert.equal(v.ok, false, name);
    assert.ok(v.errors.some((e) => e.path === p), `${name}: ошибка в ${p}, есть ${JSON.stringify(v.errors)}`);
  }
  for (const row of fx.controls.accept) {
    const v = validateEpisode(episodeWith(row), STORY);
    assert.deepEqual(v.errors, [], `${row.role} — ${row.value}`);
  }
});

test('слово не из цитаты — и в роли, и в значении; сообщение называет слово', () => {
  const role = rowWordProblems({ role: 'Напиток', value: 'чай', source: 'Утром я пила чай' });
  assert.deepEqual(role, [{ field: 'role', kind: 'missing', words: ['напиток'] }]);
  const value = rowWordProblems({ role: 'Утром', value: 'вкусный чай', source: 'Утром я пила чай' });
  assert.deepEqual(value, [{ field: 'value', kind: 'missing', words: ['вкусный'] }]);
  const v = validateEpisode(episodeWith({ role: 'Утро', value: 'чай', source: 'Утром я пила чай' }), STORY);
  assert.match(v.errors.find((e) => e.path === 'rows.0.role').msg, /«утро»/);
  // слово из рассказа, но из другой фразы — тоже не годится: сверка с цитатой этой же строки
  assert.equal(rowWordsGrounded({ role: 'Яблоко', value: 'пила', source: 'Утром я пила чай' }), false);
});

test('отрицание: из «Я не пила чай» строка «Чай | пила» отклоняется, «Чай | не пила» допустима', () => {
  const story = 'Я не пила чай.';
  const ep = (value) => sanitizeEpisode({
    date: '2026-11-11', title: 'Без чая', genre: 'камерное кино', mood: 'quiet', music: 'quiet',
    rows: [{ role: 'Чай', value, source: 'Я не пила чай' }, { role: 'Я', value: 'не пила', source: 'Я не пила чай' }],
  });
  const bad = validateEpisode(ep('пила'), story);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === 'rows.0.value' && /«пила»/.test(e.msg)));
  assert.deepEqual(validateEpisode(ep('не пила'), story).errors, []);
});

test('признаки времени, условия, сослагательности и чужого авторства не отрываются', () => {
  for (const row of fx.bound.reject) assert.equal(rowWordsGrounded(row), false, `${row.role} — ${row.value} ← ${row.source}`);
  for (const row of fx.bound.accept) assert.equal(rowWordsGrounded(row), true, `${row.role} — ${row.value} ← ${row.source}`);
});

test('цитата, обрезанная после «не» или посреди слова, не отрывает отрицание (разбор 83bfda9, блокер 1)', () => {
  const story = fx.cut.story;
  const ep = (row) => sanitizeEpisode({
    date: '2026-11-11', title: 'Без чая', genre: 'камерное кино', mood: 'quiet', music: 'quiet',
    rows: [row, { role: 'Утром', value: 'я не пила', source: 'Утром я не пила' }],
  });
  for (const row of fx.cut.reject) {
    const v = validateEpisode(ep(row), story);
    assert.equal(v.ok, false, `${row.source}`);
    assert.equal(rowWordsGrounded(row, story), false, row.source);
  }
  for (const row of fx.cut.accept) assert.deepEqual(validateEpisode(ep(row), story).errors, [], row.source);
  // модель с обрезанной цитатой: строка отбрасывается
  const { episode, dropped } = groundDraft({ title: 'Т', genre: 'камерное кино', mood: 'quiet', grammatical_gender: 'unknown',
    rows: [...fx.cut.reject, ...fx.cut.accept, { role: 'Утром я не', value: 'пила', source: 'Утром я не пила' }], post: { text: '', source: '' } }, story, { date: '2026-11-11' });
  assert.deepEqual(episode.rows.map((r) => r.source), fx.cut.accept.map((r) => r.source));
  assert.equal(dropped.length, fx.cut.reject.length + 1, 'роль из трёх слов тоже отбрасывается');
});

test('е/ё и регистр при сопоставлении допускаются; на экран идёт набранная форма', () => {
  assert.equal(rowWordsGrounded({ role: 'ЁЖИК', value: 'Ел Яблоко', source: 'ежик ел яблоко' }), true);
  assert.equal(rowWordsGrounded({ role: 'ежик', value: 'ел яблоко', source: 'Ёжик ел яблоко' }), true);
  assert.equal(rowWordsGrounded({ role: 'Ёжик', value: 'ел, яблоко!', source: 'Ёжик ел яблоко' }), true, 'пунктуация не учитывается');
  // форму не меняем: строка показывается такой, как её набрали
  const ep = sanitizeEpisode(episodeWith({ role: 'ЁЖИК', value: 'Ел Яблоко', source: 'Ежик ел яблоко' }));
  assert.equal(ep.rows[0].role, 'ЁЖИК');
});

test('промпт черновика: роль и значение — одно-два слова из рассказа в той форме, как сказаны', () => {
  assert.match(SYSTEM_PROMPT, /Роль и значение — одно-два слова из рассказа в той форме, как сказаны/);
  assert.doesNotMatch(SYSTEM_PROMPT, /слова-существительных/);
});

test('черновик модели: строки со словами не из цитаты или с оторванным «не» отбрасываются', async () => {
  const raw = {
    title: 'Чай', genre: 'камерное кино', mood: 'quiet', grammatical_gender: 'f', safety_flag: false,
    rows: [
      { role: 'Утро', value: 'чай', source: 'Утром я пила чай' },
      { role: 'Утром', value: 'чай', source: 'Утром я пила чай' },
      { role: 'Кофе', value: 'пила', source: 'Я не пила кофе' },
      { role: 'Кофе', value: 'не пила', source: 'Я не пила кофе' },
    ],
    post: { text: '', source: '' },
  };
  const { episode, dropped } = groundDraft(raw, STORY, { date: '2026-11-11' });
  assert.deepEqual(episode.rows.map((r) => `${r.role} — ${r.value}`), ['Утром — чай', 'Кофе — не пила']);
  assert.equal(dropped.length, 2);

  const client = { beta: { messages: { create: async () => ({ model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify(raw) }] }) } } };
  const r = await makeDraft(STORY, { provider: 'claude', client });
  assert.equal(r.provider, 'claude');
  assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));

  // у модели не осталось двух пригодных строк → заготовка без ИИ, и её строки тоже по правилу
  const thin = { ...raw, rows: raw.rows.filter((x) => x.role === 'Утро' || x.value === 'пила') };
  const c2 = { beta: { messages: { create: async () => ({ model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify(thin) }] }) } } };
  const r2 = await makeDraft(STORY, { provider: 'claude', client: c2 });
  assert.equal(r2.provider, 'manual');
  // Слияние с PR 14 (решение владельца 11.11 12:05, п. 4): если и заготовка не собирает двух строк — нехватка без черновика.
  assert.equal(r2.insufficient, true); assert.equal(r2.code, 'insufficient_material'); assert.equal(r2.episode, null);
  const d = await draftWithClaude(STORY, { client: c2, date: '2026-11-11' });
  assert.equal(d.episode.rows.length, 0);
});

test('заготовка без ИИ: все строки проходят правило, служебных ролей нет, нехватка — флагом', () => {
  let short = 0;
  for (const story of fx.stories) {
    const r = draftRuleBased(story, { date: '2026-11-11' });
    const v = validateSafeEpisode(r.episode, story);
    for (const row of r.episode.rows) {
      assert.ok(rowWordsGrounded(row), `${row.role} — ${row.value} ← ${row.source}`);
      assert.notEqual(row.role, 'Момент');
      assert.ok(!v.errors.some((e) => /^rows\.\d+\.(role|value|source)$/.test(e.path)), JSON.stringify(v.errors));
    }
    if (r.insufficient) {
      short++;
      assert.ok(r.episode.rows.length < LIMITS.rowsMin, story);
      assert.equal(v.ok, false, 'нехватка не уходит в ролик');
      assert.ok(v.errors.some((e) => e.path === 'rows'));
    } else {
      assert.ok(r.episode.rows.length >= LIMITS.rowsMin, story);
      assert.equal(v.ok, true, `${story}: ${JSON.stringify(v.errors)}`);
    }
  }
  assert.ok(short >= 1 && short < fx.stories.length, 'в наборе есть и нехватка, и полные черновики');
  // строки не дописываются ради минимума: LIMITS.rowsMin остаётся 2
  assert.equal(LIMITS.rowsMin, 2);
  const one = draftRuleBased('Да.', { date: '2026-11-11' });
  assert.equal(one.insufficient, true);
  assert.equal(one.episode.rows.length, 0);
});

test('заготовка без ИИ: «не» остаётся при слове, порядок слов цитаты', () => {
  // белый список формы фразы (11.11 15:05): фраза с «не» строку не даёт; простое утверждение от первого лица — даёт
  const r = draftRuleBased('Я не пила чай. Утром я пила кофе.', { date: '2026-11-11' });
  assert.deepEqual(r.episode.rows.map((x) => `${x.role} — ${x.value}`), ['Утром — пила кофе']);
});

test('примеры examples/*.json проходят новое правило', async () => {
  const dir = new URL('../examples/', import.meta.url);
  for (const f of await fs.readdir(dir)) {
    const ex = JSON.parse(await fs.readFile(new URL(f, dir), 'utf8'));
    const v = validateSafeEpisode(ex.episode, ex.story);
    assert.deepEqual(v.errors, [], f);
    assert.ok(ex.episode.rows.every(rowWordsGrounded), f);
  }
});

// ── Ручная правка: бот ───────────────────────────────────────────────────────

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    send: async (chat, text, extra) => { sent.push({ text, extra }); },
    action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''),
    sendVideo: async () => { sent.push({ text: 'VIDEO' }); },
  };
}
const playId = (tg) => [...tg.sent].reverse().find((m) => m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard)
  .extra.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];

test('бот: правка строки — цитата из того, что человек написал; роль без опоры не уходит в ролик', async () => {
  // чистая функция: роль и текст из правки становятся цитатой строки
  const { episode } = draftRuleBased('Утром я работала. Днём я встретилась с другом. Вечером мы ужинали.', { date: '2026-11-11' });
  assert.equal(applyEdit(episode, { op: 'add', role: 'Ночью', value: 'я смотрела в окно' }), null);
  assert.deepEqual(episode.rows.at(-1), { role: 'Ночью', value: 'я смотрела в окно', source: 'Ночью я смотрела в окно' });
  // не простое утверждение от первого лица — опоры нет
  assert.equal(applyEdit(episode, { op: 'add', role: 'Окно', value: 'долгий вечер' }), null);
  assert.equal(episode.rows.at(-1).source, '');
  episode.rows.pop();

  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-bot-'));
  const rendered = [];
  const render = async (ep, opts) => { rendered.push(ep); await fs.mkdir(path.dirname(opts.outPath), { recursive: true }); await fs.writeFile(opts.outPath, 'x'); return { outPath: opts.outPath, duration: 24, seconds: 1 }; };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render, draft: (s, o) => makeDraft(s, { ...o, provider: 'manual' }) });
  const chat = { id: 77, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: 'Утром я работала. Днём я встретилась с другом. Вечером мы ужинали.' } });
    // только новый текст из одного слова: пару не собрать, прежняя роль «Утром» без опоры → ошибка, ролик не собирается
    await bot.handleUpdate({ message: { chat, text: '1: работала' } });
    assert.match(tg.sent.at(-1).text, /Строка 1: .*«1: Утром — я пила чай»/);
    assert.doesNotMatch(tg.sent.at(-1).text, /цитат/);
    await bot.handleUpdate({ callback_query: { id: 'a', data: `play:${playId(tg)}`, message: { chat } } });
    assert.equal(rendered.length, 0, 'строка без опоры не рендерится');
    // роль и текст вместе — это слова человека, строка проходит
    await bot.handleUpdate({ message: { chat, text: '1: Утром — я тихо работала' } });
    assert.doesNotMatch(tg.sent.at(-1).text, /⚠/);
    await bot.handleUpdate({ callback_query: { id: 'b', data: `play:${playId(tg)}`, message: { chat } } });
    assert.equal(rendered.length, 1);
    assert.deepEqual(rendered[0].rows[0], { role: 'Утром', value: 'я тихо работала', source: 'Утром я тихо работала' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ── Ручная правка: монтажная ─────────────────────────────────────────────────

test('монтажная: строка «Утро — чай» — 422 без рендера; «Утром — чай» — рендер', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-app-'));
  let renders = 0;
  const server = createApp({ dataDir, safetyCheck: async () => false, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const bad = episodeWith({ role: 'Утро', value: 'чай', source: 'Утром я пила чай' });
    const val = await post('/api/validate', { episode: bad, story: STORY });
    assert.ok(val.body.validation.errors.some((e) => e.path === 'rows.0.role'));
    const r1 = await post('/api/render', { episode: bad, story: STORY });
    assert.equal(r1.status, 422);
    assert.equal(renders, 0);
    const r2 = await post('/api/render', { episode: episodeWith({ role: 'Утром', value: 'чай', source: 'Утром я пила чай' }), story: STORY });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(renders, 1);
  } finally { server.closeAllConnections(); server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

// ── Повторный разбор b9c5a9a0 ────────────────────────────────────────────────

test('«нет», чужие слова и мысли, неуверенность, сон, «почти», перенос строки после «не», «Не я»', () => {
  for (const { story, row } of fx.review2.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review2.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

test('промпт: каждый пример строки проходит правило на своём вымышленном рассказе', () => {
  const EXAMPLES = [
    { quote: 'утром я пила чай', role: 'Утром', value: 'пила чай' },
    { quote: 'я не пила кофе', role: 'Кофе', value: 'не пила' },
    { quote: 'я отправила письмо', role: 'Письмо', value: 'отправила' },
    { quote: 'друг позвонил', role: 'Друг', value: 'позвонил' },
    { quote: 'думала, что он злится, но не знаю', role: 'Думала', value: 'что он злится, но не знаю' },
    { quote: 'может, завтра ответят', role: 'Завтра', value: 'может, ответят' },
  ];
  for (const ex of EXAMPLES) {
    assert.ok(SYSTEM_PROMPT.includes(`из «${ex.quote}» — «${ex.role} — ${ex.value}»`), `пример есть в промпте: ${ex.role} — ${ex.value}`);
    assert.ok(rowWordsGrounded({ role: ex.role, value: ex.value, source: ex.quote }, `${ex.quote}.`), `${ex.role} — ${ex.value}`);
  }
  // в промпте не осталось прежних примеров, которые правило отбрасывает
  for (const old of ['Письмо — отправлено', '«Человек»', 'Мысль — о возможной', 'Надежда — на ответ', 'значение — до 6 слов']) {
    assert.ok(!SYSTEM_PROMPT.includes(old), old);
  }
  // каждая пара «X — Y» в кавычках в промпте — один из проверенных примеров (кроме запрещённого «Ты отправила…»)
  const pairs = [...SYSTEM_PROMPT.matchAll(/«([А-ЯЁ][^«»—]*?) — ([^«»]+?)»/g)].map((m) => `${m[1]} — ${m[2]}`);
  const known = new Set(EXAMPLES.map((e) => `${e.role} — ${e.value}`));
  assert.deepEqual(pairs.filter((x) => !known.has(x)), []);
});

test('заготовка: значение — непрерывный кусок фразы рядом с ролью, порядок слов сохранён', () => {
  const r = draftRuleBased(fx.ruleBasedOrder.story, { date: '2026-11-11' });
  assert.deepEqual(r.episode.rows.map((x) => `${x.role} — ${x.value}`), fx.ruleBasedOrder.rows);
  for (const row of r.episode.rows) {
    const src = row.source.toLowerCase();
    assert.ok(src.includes(row.value.toLowerCase()), `значение — кусок цитаты: ${row.value}`);
    assert.ok(src.includes(row.role.toLowerCase()), `роль — кусок цитаты: ${row.role}`);
  }
  // имя в начале фразы остаётся с заглавной, если человек пишет его так и в середине фразы
  // (фразы от первого лица — белый список 11.11)
  const m = draftRuleBased('Я встретила Машу у дома. Потом я проводила Машу до метро. Вечером я читала.', { date: '2026-11-11' });
  assert.ok(m.episode.rows.some((x) => /Машу/.test(x.value)), "имя в значении — с заглавной, как у человека");
  assert.ok(!m.episode.rows.some((x) => /(^|\s)машу/.test(x.value)));
});

test('бот: «N: текст» — роль из слов этого текста; подсказка и ошибки без слова «цитата»', () => {
  const { episode } = draftRuleBased('Утром я работала. Днём я встретилась с другом. Вечером мы ужинали.', { date: '2026-11-11' });
  // «N: текст» — простое утверждение от первого лица: роль и значение из его слов
  assert.equal(applyEdit(episode, parseEdit('1: вечером я позвонила другу')), null);
  assert.deepEqual(episode.rows[0], { role: 'Вечером', value: 'позвонила другу', source: 'вечером я позвонила другу' });
  assert.ok(rowWordsGrounded(episode.rows[0], 'вечером я позвонила другу'));
  // не первое лицо или придаточное — пары нет, прежняя роль без опоры, ролик не соберётся
  const ep2 = draftRuleBased('Утром я работала. Днём я встретилась с другом.', { date: '2026-11-11' }).episode;
  assert.equal(applyEdit(ep2, parseEdit('1: друг позвонил поговорить')), null);
  assert.notEqual(ep2.rows[0].role, 'Друг');
  // текст из одного слова — пары нет: прежняя роль остаётся, человек видит понятную ошибку
  assert.equal(applyEdit(episode, parseEdit('2: ужинали')), null);
  const v = validateEpisode(episode, 'Утром я работала. Днём я встретилась с другом. Вечером мы ужинали.\nвечером я позвонила другу\nужинали');
  assert.equal(v.ok, false);
  const msg = draftMessage(episode, v);
  assert.match(msg, /Строка 2: /);
  assert.doesNotMatch(msg, /цитат/);
});

// ── Третий разбор c3f698e0 ───────────────────────────────────────────────────

test('«не» на всю часть фразы, «не…», чужие слова без «что», «во сне», кавычки, «не я»; слова-связки не мешают', () => {
  for (const { story, row } of fx.review3.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${row.source} / ${story}`);
  }
  for (const { story, row } of fx.review3.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

test('заготовка: не обрывает значение на предлоге, служебном слове или кавычке; не отрывает «не»', () => {
  const r = draftRuleBased(fx.ruleBased3.story, { date: '2026-11-11' });
  const got = r.episode.rows.map((x) => `${x.role} — ${x.value}`);
  for (const bad of fx.ruleBased3.forbidden) assert.ok(!got.includes(bad), bad);
  for (const row of r.episode.rows) {
    assert.ok(rowWordsGrounded(row, fx.ruleBased3.story), `${row.role} — ${row.value}`);
    assert.doesNotMatch(row.value, /\s(в|на|с|то|чтобы|не)$/);
  }
});

test('бот: правка «N: пила чай» при «Я не пила чай» в рассказе — это слова человека, строка проходит; ошибки по причине', () => {
  const story = 'Я не пила чай. Утром я работала. Вечером мы ужинали.';
  const { episode } = draftRuleBased(story, { date: '2026-11-11' });
  assert.equal(applyEdit(episode, parseEdit('1: я пила чай')), null);
  const v = validateEpisode(episode, `${story}\nя пила чай`);
  assert.ok(!v.errors.some((e) => e.path.startsWith('rows.0')), JSON.stringify(v.errors));
  // разные причины — разные понятные тексты
  const e1 = validateEpisode(sanitizeEpisode({ ...episode, rows: [{ role: 'Чай', value: 'пила', source: 'пила чай' }, episode.rows[1]] }), story);
  assert.match(draftMessage(episode, e1), /перед этими словами стоит «не»/);
});

// ── Разбор головы dfee587e ───────────────────────────────────────────────────

test('признак через «...», перевод строки после двоеточия и кавычки; чужие слова, сон, неуверенность; «почти» при своём слове; «нечего», «без»; намерение', () => {
  for (const { story, row } of fx.review4.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review4.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

test('заготовка: порядок слов цитаты, признак не роль, все строки по правилу', () => {
  const story = fx.ruleBased4.story;
  const r = draftRuleBased(story, { date: '2026-11-11' });
  const got = r.episode.rows.map((x) => `${x.role} — ${x.value}`);
  for (const bad of fx.ruleBased4.forbidden) assert.ok(!got.includes(bad), bad);
  for (const row of r.episode.rows) {
    assert.ok(rowWordsGrounded(row, story), `${row.role} — ${row.value}`);
    // роль стоит в цитате раньше значения
    const src = row.source.toLowerCase();
    assert.ok(src.indexOf(row.role.toLowerCase()) < src.indexOf(row.value.toLowerCase()), `порядок: ${row.role} — ${row.value}`);
  }
  for (const s of ['Почти уснула за рулём.', 'Еле дошла до дома.', 'Мне снится, что я лечу.']) {
    const pair = pairFromSentence(s, new Set(), s);
    assert.ok(!pair || !/^(Почти|Еле|Снится)/.test(pair.row.role), s);
  }
  // белый список: «Моя дочь пошла в школу» — не первое лицо, пары нет; «Я отвела дочь в школу» — есть
  assert.equal(pairFromSentence('Моя дочь пошла в школу.', new Set(), 'Моя дочь пошла в школу.'), null);
  assert.equal(pairFromSentence('Я отвела дочь в школу.', new Set(), 'Я отвела дочь в школу.').row.role, 'Дочь');
});

// ── Разбор 46b47503 ──────────────────────────────────────────────────────────

test('«почти» через определения, чужие слова через тире и перевод строки, сон и неуверенность, кавычки, «без» и намерение', () => {
  for (const { story, row } of fx.review5.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review5.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

test('слово с символами регулярных выражений в рассказе не роняет проверку и заготовку', () => {
  const story = fx.review5.crash;
  assert.doesNotThrow(() => validateEpisode(sanitizeEpisode({ date: '2026-11-11', title: 'Т', genre: 'камерное кино',
    rows: [{ role: 'Я', value: 'лентяйка', source: 'я лентяйка' }, { role: 'Мама', value: 'лентяйка', source: 'я лентяйка' }] }), story));
  assert.doesNotThrow(() => draftRuleBased(story, { date: '2026-11-11' }));
  assert.doesNotThrow(() => rowWordProblems({ role: 'Я', value: 'лентяйка', source: 'я лентяйка' }, story));
});

// ── Разбор 78b6630e ──────────────────────────────────────────────────────────

test('«без» и намерение не приставляются, двоеточие без пробела, область через запятую перед инфинитивом, «могу»', () => {
  for (const { story, row } of fx.review6.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review6.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  // рассказ строками без точек: строки остаются отдельными фразами, заготовка не пустая
  // белый список: из строк от первого лица («утром пила кофе») строка берётся, «потом работа до шести» — нет
  const lines = 'утром я пила кофе\nпотом мы работали до шести\nвечером я ходила на йогу\nя легла в одиннадцать';
  assert.ok(draftRuleBased(lines, { date: '2026-11-11' }).episode.rows.length >= 2);
});

test('время проверки линейно: рассказ ~6000 знаков с повторами глагола речи — меньше 3 секунд', () => {
  const ep = sanitizeEpisode({ date: '2026-11-11', title: 'Т', genre: 'камерное кино',
    rows: Array.from({ length: 6 }, () => ({ role: 'Я', value: 'думала', source: 'думала думала' })) });
  const bigs = ['думала '.repeat(850), 'сказала '.repeat(750), 'я сказала что '.repeat(430),
    // разбор 88066e51: переводы строк внутри кавычек и длинная фраза без точек в кавычках
    '"' + 'а\n'.repeat(3000), '«' + 'а,\n'.repeat(2000), 'а не\n'.repeat(1500), '«' + 'утром пила чай\n'.repeat(400),
    '«' + 'утром пила чай '.repeat(400), 'хотела пить чай без сахара '.repeat(230)];
  for (const big of bigs) {
    const t0 = Date.now();
    validateEpisode(ep, big);
    draftRuleBased(big, { date: '2026-11-11' });
    assert.ok(Date.now() - t0 < 3000, `${big.slice(0, 14)}…: ${Date.now() - t0} мс`);
  }
});

// ── Разбор 776098de ──────────────────────────────────────────────────────────

test('чужие слова и мнение где угодно во фразе, намерение по общему правилу, вопрос, сон через границу фразы', () => {
  for (const { story, row } of fx.review7.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review7.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  // заготовка не делает строку-факт из вопроса и из чужого мнения
  const r = draftRuleBased('По её мнению я ленивая. Я поехала на дачу? Нет, осталась дома. Утром работа. Днём встреча с другом.', { date: '2026-11-11' });
  const got = r.episode.rows.map((x) => `${x.role} — ${x.value}`);
  assert.ok(!got.some((x) => /ленивая|мнению|на дачу/i.test(x)), JSON.stringify(got));
});

test('заготовка: фраза в 20 тысяч знаков не разбирается долго', () => {
  const big = 'утром пила чай '.repeat(1400);
  const t0 = Date.now();
  pairFromSentence(big, new Set(), big);
  draftRuleBased(big, { date: '2026-11-11' });
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} мс`);
});

// ── Разбор 8fb7f3de ──────────────────────────────────────────────────────────

test('мнение, неуверенность, вопрос без «?», сон до конца абзаца, план и нужда, отказ от сказанного', () => {
  for (const { story, row } of fx.review8.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review8.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
});

test('вырожденный рассказ из одного слова и null в строках: быстро и без падения', () => {
  const ep = { date: '2026-11-11', title: 'Т', genre: 'камерное кино', mood: 'quiet', music: 'quiet', period: 'day',
    rows: Array.from({ length: 6 }, () => ({ role: 'В', value: 'в', source: 'в' })) };
  for (const big of ['в '.repeat(3000), 'и '.repeat(3000), 'а '.repeat(3000)]) {
    const t0 = Date.now();
    validateEpisode(ep, big);
    assert.ok(Date.now() - t0 < 3000, `${big.slice(0, 4)}…: ${Date.now() - t0} мс`);
  }
  assert.doesNotThrow(() => validateEpisode({ ...ep, rows: [null, { role: 'Т', value: 'т', source: 'т' }] }, 'т'));
});

// ── Разбор cf0c2497 ──────────────────────────────────────────────────────────

test('сон через переводы строк и «проснулась» внутри сна; обрезка после «не» через много прозрачных слов', () => {
  for (const { story, row } of fx.review9.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review9.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
});

// ── Разбор 9a7a206b ──────────────────────────────────────────────────────────

test('сон до явного «я проснулась», видения и кошмар, -сть/-зть, источник без глагола, признак в конце фразы, предел фразы', () => {
  for (const { story, row } of fx.review10.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story).slice(0, 90)}`);
  }
  for (const { story, row } of fx.review10.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  // заготовка не делает служебные слова ролью и не берёт строки из сна и источника
  const r = draftRuleBased('Мне снилось море. Бабушка проснулась. Мама пекла пироги. Рейс, согласно табло, отменён. Уже поздно.', { date: '2026-11-11' });
  assert.ok(!r.episode.rows.some((x) => /^(Уже|Согласно|Мама)/.test(x.role)), JSON.stringify(r.episode.rows));
});

test('монтажная: рассказ длиннее 6000 знаков — 413 до проверки строк, рендер не вызывается', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-long-'));
  let renders = 0;
  const server = createApp({ dataDir, safetyCheck: async () => false, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
  try {
    const story = 'Утром я пила чай. '.repeat(400);
    const ep = episodeWith({ role: 'Утром', value: 'чай', source: 'Утром я пила чай' });
    assert.equal(await post('/api/validate', { episode: ep, story }), 413);
    assert.equal(await post('/api/render', { episode: ep, story }), 413);
    assert.equal(renders, 0);
  } finally { server.closeAllConnections(); server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

// ── Разбор ed1298f1 ──────────────────────────────────────────────────────────

test('чужие оценки, пробуждение только от первого лица, синонимы сна, перенос из конца фразы, источники', () => {
  for (const { story, row } of fx.review11.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review11.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
});

test('makeDraft: длинный опасный рассказ останавливается по безопасности, а не ошибкой длины', async () => {
  const r = await makeDraft('Утром я пила чай. '.repeat(400) + 'Я не хочу больше жить.', { provider: 'manual' });
  assert.equal(r.episode, null);
  assert.equal(r.risk.level, 'urgent');
  await assert.rejects(makeDraft('Утром я пила чай. '.repeat(400), { provider: 'manual' }), (e) => e.code === 'too_long');
});

// ── Разбор 116cb152 ──────────────────────────────────────────────────────────

test('перенос признака на следующую фразу, сарказм после пробуждения, оценки, паузы перед инфинитивом', () => {
  for (const { story, row } of fx.review12.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review12.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  // цитата длиннее предела фразы не источник и не разбирается долго
  const long = 'я '.repeat(3000);
  const t0 = Date.now();
  assert.equal(rowWordsGrounded({ role: 'Я', value: 'я', source: long }, long), false);
  assert.ok(Date.now() - t0 < 3000);
});

// ── Разбор 772a5dd7 ──────────────────────────────────────────────────────────

test('пробуждение без сомнений, перенос сказанного и источника, формы оценок', () => {
  for (const { story, row } of fx.review13.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review13.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
});

// ── Белый список формы фразы (решение Claude 11.11 15:05) ─────────────────────

test('белый список: только простое утверждение от первого лица даёт строку заготовки', () => {
  const ok = ['Утром я пила чай.', 'Днём я работала в офисе.', 'Вечером мы гуляли в парке.', 'Я купила хлеб и молоко.'];
  const no = [
    'Мама пекла пироги.', 'Анализы хорошие.', 'Бабушка проснулась.', 'Утром работа.', 'Днём работала в офисе.', // не первое лицо
    'Мама пекла мне пироги.', 'Начальник меня уволил.', 'Пчела ужалила в руку.', 'Павел ушёл утром.', // «мне», имена на -л
    'Я поеду на море.', 'Я хорошая мать.', 'Я жила в Париже, по легенде.', 'Я пила чай, а мама пекла пироги.', // будущее, оценка, запятая
    'Я думала, что он злится.', 'Я ушла, когда стемнело.', 'Я не пила чай.', 'Я пила чай без сахара.', // придаточное, отрицание
    'Я пила «Эрл Грей».', 'Я сказала: хватит.', 'Я пила чай?', 'Я (кажется) пила чай.', // кавычки, двоеточие, вопрос, скобки
    'Мне снилось, я летала.', 'Наверное, я устала.', 'Я хотела поехать на дачу.', 'По данным врача, я здорова.', // сон, неуверенность, намерение, источник
    'Говорят, я ленивая.', 'Я почти упала.', 'Я пила… чай.',
  ];
  for (const s of ok) assert.equal(plainPhrase(s), true, s);
  for (const s of no) assert.equal(plainPhrase(s), false, s);
  // признаки соседних фраз: сон до явного «Я проснулась.», перенос сказанного
  assert.equal(plainPhrase('Я пила чай.', 'Мне снилось море. Я пила чай.'), false);
  assert.equal(plainPhrase('Я пила чай.', 'Мне снилось море. Я проснулась. Я пила чай.'), true);
  assert.equal(plainPhrase('Я пила чай.', 'Мне снилось море. Я будто проснулась. Я пила чай.'), false);
  assert.equal(plainPhrase('Я пила чай.', 'Мне снилось море. Вдруг я проснулась. Я пила чай.'), false);
  assert.equal(plainPhrase('Я пила чай.', 'Медсестра сказала. Я пила чай.'), false);
});

test('все случаи прошлых разборов: заготовка не даёт ни отклонённых строк, ни строк из неплоских фраз', () => {
  const sets = Object.keys(fx).filter((k) => /^review\d+$|^cut$|^bound$/.test(k));
  for (const k of sets) {
    for (const c of fx[k].reject || []) {
      const story = c.story || (fx[k].story ?? c.source);
      if (!story) continue;
      const r = draftRuleBased(story, { date: '2026-11-11' });
      const row = c.row || c;
      for (const got of r.episode.rows) {
        assert.ok(rowWordsGrounded(got, story), `${k}: ${got.role} — ${got.value}`);
        assert.ok(plainPhrase(got.source, story), `${k}: строка не из простого утверждения: ${got.source}`);
        assert.ok(!(got.role.toLowerCase() === String(row.role).toLowerCase() && got.value.toLowerCase() === String(row.value).toLowerCase()),
          `${k}: заготовка выдала отклонённую строку ${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
      }
    }
  }
});

test('белый список (разбор 7595d8d9): «мне/моя», имена на -л, будущее, оценка, сон через «уснула», ложь наперёд, сцена после титров, бот', () => {
  for (const x of ['Мама пекла мне пироги.', 'Мой брат заболел гриппом.', 'Моя мама умерла весной.', 'Начальник меня уволил.',
    'Врачи нашли у меня опухоль.', 'Муж меня ударил.', 'Пчела ужалила в руку.', 'Павел ушёл утром.', 'Михаил уехал в Москву.',
    'Школа закрылась на карантин.', 'Стол сломался вечером.', 'Я поеду на море.', 'Я завтра поеду на море.', 'Я стану врачом.',
    'Я хорошая мать.', 'Я самая умная.', 'Я виновата во всём.', 'Я жила в Париже, по легенде.']) {
    assert.equal(plainPhrase(x), false, x);
  }
  assert.equal(plainPhrase('Я летала над городом.', 'Я уснула днём. Я летала над городом.'), false);
  assert.equal(plainPhrase('Я обнимала маму.', 'Я заснула и видела маму. Я обнимала маму.'), false);
  assert.equal(plainPhrase('Я купила яхту.', 'Я наврала всем. Я выиграла миллион. Я купила яхту.'), false);
  // сцена после титров — тоже только из простого утверждения
  assert.equal(draftRuleBased('Я пила чай. Я гуляла в парке. Я читала книгу. Мама сказала, что я дура.', { date: '2026-11-11' }).episode.post.text, '');
  // бот: «N: текст» и «N: роль — текст» не из простой фразы — опоры нет, проверка не проходит
  const story = 'Утром я пила кофе на кухне. Днём я работала. Вечером мы гуляли.';
  for (const edit of ['1: Утром мама пекла пироги', '1: Утром анализы хорошие', '1: Утром мне приснилось море', '1: Мама — пекла пироги',
    '1: Говорят — я уволена', '1: Мама сказала - я дура', '+ Мне снилось — я летала']) {
    const { episode } = draftRuleBased(story, { date: '2026-11-11' });
    applyEdit(episode, parseEdit(edit));
    const n = edit.startsWith('+') ? episode.rows.length - 1 : 0;
    const v = validateSafeEpisode(episode, `${story}\n${edit.replace(/^\+\s*|^\d+\s*:\s*/, '').replace(/\s+[—–-]\s+/, ' ')}`);
    assert.ok(v.errors.some((e) => e.path.startsWith(`rows.${n}`)), `${edit}: ${JSON.stringify(episode.rows[n])}`);
  }
});

test('сессия PR 14: правка в боте не сверяется с признаками рассказа; «кричал.», «читала» не заражают следующую фразу', async () => {
  // заготовка: глагол манеры речи в конце фразы не переносится
  const d = draftRuleBased('Брат кричал. Утром я пила чай. Вечером я читала книгу. Днём я работала.', { date: '2026-11-11' });
  assert.ok(d.episode.rows.some((x) => x.role === 'Утром' && x.value === 'пила чай'), JSON.stringify(d.episode.rows));
  // бот: правка «N: текст» после «Вечером я читала книгу.» — без ⚠
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-pr14-'));
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render: async (e, o) => ({ outPath: o.outPath, duration: 24, seconds: 1 }), draft: (st, o) => makeDraft(st, { ...o, provider: 'manual' }) });
  const chat = { id: 78, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: 'Утром я пила чай. Вечером я читала книгу. Мне снилось море.' } });
    for (const edit of ['2: вечером я гуляла в парке', '2: я гуляла в парке с собакой', '1: Утром — я пила кофе']) {
      await bot.handleUpdate({ message: { chat, text: edit } });
      assert.doesNotMatch(tg.sent.at(-1).text, /⚠ Строка/, edit);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('белый список (разбор eeec1864): придаточное без запятой, третье лицо после «и», роль «Я», «после:», кавычки ‘ ’, «？», приставки, пробуждение', () => {
  for (const x of ['Я видела мама плакала.', 'Я поняла муж ушёл к другой.', 'Я услышала соседи развелись.', 'Я вспомнила папа умер.',
    'Я почувствовала он врал.', 'Я плакала ведь он ушёл.', 'Я купила хлеб и мама испекла торт.', 'Я он меня ударил.', 'Мы соседи развелись.',
    'Я получила ‘ты уволена’ от шефа.', "Я получила 'ты уволена' от шефа.", 'Я пила чай？', 'Я выиграла миллион‽', 'Я походу проспала работу.',
    'Я пообещала себе отпуск.', 'Я запланировала отпуск.', 'Я заподозрила мужа в измене.']) {
    assert.equal(plainPhrase(x), false, x);
  }
  for (const pre of ['Утром я проснулась.', 'Потом я проснулась.', 'Проснувшись, я встала.']) {
    assert.equal(plainPhrase('Я купила квартиру.', `Мне снилось море. ${pre} Я купила квартиру.`), false, pre);
  }
  assert.equal(plainPhrase('Я выбежала на улицу.', 'Я вообразила себе пожар. Я выбежала на улицу.'), false);
  assert.equal(plainPhrase('Я встретила президента.', 'Я легла рано. Я вырубилась. Я встретила президента.'), false);
  for (const lie of ['Я всем приукрасила.', 'Я наплела всем с три короба.', 'Я пошутила.']) {
    assert.equal(plainPhrase('Я выиграла миллион.', `${lie} Я выиграла миллион.`), false, lie);
  }
  // бот: роль «Я»/«Мы» и «после:» не из простой фразы — опоры нет
  const { episode } = draftRuleBased('Утром я пила кофе. Днём я работала. Вечером мы гуляли.', { date: '2026-11-11' });
  applyEdit(episode, parseEdit('2: Я — он меня ударил'));
  assert.equal(episode.rows[1].source, '');
  applyEdit(episode, parseEdit('+ Мы — соседи развелись'));
  assert.equal(episode.rows.at(-1).source, '');
  applyEdit(episode, parseEdit('после: Мама сказала, что я плохая.'));
  assert.equal(episode.post.source, '');
  assert.ok(validateEpisode(episode, 'Утром я пила кофе.').errors.some((e) => e.path === 'post.source'));
});

test('разбор 3689eb93: разделитель правок не приходит из рассказа; безопасность видит правку как продолжение; опровержения; манера речи', async () => {
  const rows = (st) => draftRuleBased(st, { date: '2026-11-11' }).episode.rows.map((x) => `${x.role} — ${x.value}`);
  // рассказ с разделителем (или «⁂») не снимает сон
  for (const sep of [EDIT_SEP, '\n⁂\n']) {
    assert.deepEqual(rows(`Мне приснился сон.${sep}Я купила квартиру. Я пила кофе. Я гуляла по набережной.`), [], JSON.stringify(sep));
    const md = await makeDraft(`Мне приснился сон.${sep}Я купила квартиру. Я пила кофе. Я гуляла по набережной.`, { provider: 'manual' });
    assert.ok(!md.episode || md.episode.rows.length === 0);
  }
  // безопасность: «Я хочу» + правка «умереть» — как раньше, urgent
  const ep = sanitizeEpisode({ date: '2026-11-11', title: 'Т', genre: 'камерное кино', rows: [] });
  assert.equal(assessEpisodeRisk(joinEdits(`Я так устала. Я хочу${EDIT_SEP}умереть`), ep).level, 'urgent');
  // манера речи с дополнением и чтение — заражают следующую фразу; «кричал.» в конце — нет
  for (const st of ['Утром я пила чай. Я прочитала в газете. Мы выиграли чемпионат. Я гуляла.', 'Утром я пила чай. Брат орал на меня. Я испортила праздник. Я гуляла.',
    'Утром я пила чай. Мама читала мне сказку. Я победила дракона. Я гуляла.']) {
    assert.ok(!rows(st).some((r) => /чемпионат|праздник|дракон/.test(r)), st);
  }
  // «отрубилась» — сон; опровержение после рассказанного
  assert.ok(!rows('Я отрубилась. Я летала над городом. Я встретила папу. Я гуляла.').some((r) => /городом|папу/.test(r)));
  assert.deepEqual(rows('Я купила квартиру. Я пила кофе. Я гуляла по набережной. Я ела круассан. Но это был сон.'), []);
  assert.equal(plainPhrase('Я купила квартиру.', 'Я купила квартиру. Это неправда.'), false);
  assert.equal(plainPhrase('Я пила чай.', 'Я пила чай. Это неправда. Я гуляла.'), false);
  assert.equal(plainPhrase('Я гуляла.', 'Я пила чай. Это неправда. Я гуляла.'), true, 'опровержение — только для предыдущей фразы');
  for (const x of ['Я купила квартиру зря.', 'Я купила квартиру к сожалению.', 'Я купила квартиру понарошку.', 'Я засомневалась в нём.',
    'Я предположила худшее.', 'Я гадала о будущем.']) assert.equal(plainPhrase(x), false, x);
});
