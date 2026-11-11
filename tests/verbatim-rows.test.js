// Правило «слова строки — только из её цитаты» (владелец вместе с редактором, ответ 11.11 09:05).
// Все тексты — вымышленные (tests/fixtures/verbatim-rows.json и examples/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, rowWordProblems, rowWordsGrounded, sanitizeEpisode, validateEpisode } from '../engine/episode.js';
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
  assert.ok(r2.episode.rows.every(rowWordsGrounded));
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
  const r = draftRuleBased('Я не пила чай. Утром работа.', { date: '2026-11-11' });
  // порядок слов как в цитате: «не» уходит в роль вместе со словом (разбор dfee587e)
  assert.deepEqual(r.episode.rows.map((x) => `${x.role} — ${x.value}`), ['Не пила — чай', 'Утром — работа']);
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
  const { episode } = draftRuleBased('Утром работа. Днём встреча с другом. Вечером ужин.', { date: '2026-11-11' });
  assert.equal(applyEdit(episode, { op: 'add', role: 'Окно', value: 'долгий вечер' }), null);
  assert.deepEqual(episode.rows.at(-1), { role: 'Окно', value: 'долгий вечер', source: 'Окно долгий вечер' });

  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-bot-'));
  const rendered = [];
  const render = async (ep, opts) => { rendered.push(ep); await fs.mkdir(path.dirname(opts.outPath), { recursive: true }); await fs.writeFile(opts.outPath, 'x'); return { outPath: opts.outPath, duration: 24, seconds: 1 }; };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render, draft: (s, o) => makeDraft(s, { ...o, provider: 'manual' }) });
  const chat = { id: 77, type: 'private' };
  try {
    await bot.handleUpdate({ message: { chat, text: 'Утром работа. Днём встреча с другом. Вечером ужин.' } });
    // только новый текст из одного слова: пару не собрать, прежняя роль «Утром» без опоры → ошибка, ролик не собирается
    await bot.handleUpdate({ message: { chat, text: '1: работала' } });
    assert.match(tg.sent.at(-1).text, /Строка 1: .*«1: роль — текст»/);
    assert.doesNotMatch(tg.sent.at(-1).text, /цитат/);
    await bot.handleUpdate({ callback_query: { id: 'a', data: `play:${playId(tg)}`, message: { chat } } });
    assert.equal(rendered.length, 0, 'строка без опоры не рендерится');
    // роль и текст вместе — это слова человека, строка проходит
    await bot.handleUpdate({ message: { chat, text: '1: Утром — тихая работа' } });
    assert.doesNotMatch(tg.sent.at(-1).text, /⚠/);
    await bot.handleUpdate({ callback_query: { id: 'b', data: `play:${playId(tg)}`, message: { chat } } });
    assert.equal(rendered.length, 1);
    assert.deepEqual(rendered[0].rows[0], { role: 'Утром', value: 'тихая работа', source: 'Утром тихая работа' });
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
  const m = draftRuleBased('Маша пришла. Потом пришёл кот, и Маша ушла.', { date: '2026-11-11' });
  assert.ok(m.episode.rows.some((x) => /Маша/.test(x.role + x.value)));
  assert.ok(!m.episode.rows.some((x) => /(^|\s)маша/.test(x.value)));
});

test('бот: «N: текст» — роль из слов этого текста; подсказка и ошибки без слова «цитата»', () => {
  const { episode } = draftRuleBased('Утром работа. Днём встреча с другом. Вечером ужин.', { date: '2026-11-11' });
  assert.equal(applyEdit(episode, parseEdit('1: друг позвонил поговорить')), null);
  assert.deepEqual(episode.rows[0], { role: 'Друг', value: 'позвонил поговорить', source: 'друг позвонил поговорить' });
  assert.ok(rowWordsGrounded(episode.rows[0], 'друг позвонил поговорить'));
  // текст из одного слова — пары нет: прежняя роль остаётся, человек видит понятную ошибку
  assert.equal(applyEdit(episode, parseEdit('2: ужинали')), null);
  const v = validateEpisode(episode, 'Утром работа. Днём встреча с другом. Вечером ужин.\nдруг позвонил поговорить\nужинали');
  assert.equal(v.ok, false);
  const msg = draftMessage(episode, v);
  assert.match(msg, /Строка 2: .*«2: роль — текст»/);
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
  const story = 'Я не пила чай. Утром работа. Вечером ужин.';
  const { episode } = draftRuleBased(story, { date: '2026-11-11' });
  assert.equal(applyEdit(episode, parseEdit('1: пила чай')), null);
  const v = validateEpisode(episode, `${story}\nпила чай`);
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
  assert.equal(pairFromSentence('Моя дочь пошла в школу.', new Set(), 'Моя дочь пошла в школу.').row.role, 'Дочь');
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
  assert.ok(draftRuleBased(fx.review6.lines, { date: '2026-11-11' }).episode.rows.length >= 2);
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
