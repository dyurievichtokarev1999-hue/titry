// Правило «слова строки — только из её цитаты» (владелец вместе с редактором, ответ 11.11 09:05).
// Все тексты — вымышленные (tests/fixtures/verbatim-rows.json и examples/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EDIT_SEP, LIMITS, joinEdits, rowWordProblems, rowWordsGrounded, sanitizeEpisode, validateEpisode } from '../engine/episode.js';
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
  assert.ok(r2.episode.rows.every(rowWordsGrounded));
  const d = await draftWithClaude(STORY, { client: c2, date: '2026-11-11' });
  assert.equal(d.episode.rows.length, 0);
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

test('«не» на всю часть фразы, «не…», чужие слова без «что», «во сне», кавычки, «не я»; слова-связки не мешают', () => {
  for (const { story, row } of fx.review3.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${row.source} / ${story}`);
  }
  for (const { story, row } of fx.review3.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

test('признак через «...», перевод строки после двоеточия и кавычки; чужие слова, сон, неуверенность; «почти» при своём слове; «нечего», «без»; намерение', () => {
  for (const { story, row } of fx.review4.reject) {
    assert.equal(rowWordsGrounded(row, story), false, `${row.role} — ${row.value} ← ${JSON.stringify(story)}`);
  }
  for (const { story, row } of fx.review4.accept) {
    assert.deepEqual(rowWordProblems(row, story), [], `${row.role} — ${row.value} ← ${story}`);
  }
});

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
  // рассказ строками без точек: строки остаются отдельными фразами — признак одной строки не переходит на другую
  const lines = 'утром я пила кофе\nднём почти не спала\nвечером я ходила на йогу';
  assert.deepEqual(rowWordProblems({ role: 'Вечером', value: 'ходила на йогу', source: 'вечером я ходила на йогу' }, lines), []);
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


// ── Вариант 1 (решение Claude 12.11 11:05) ───────────────────────────────────

test('заготовка без модели строк не предлагает: всегда нехватка (флаг insufficient), строки не дописываются', async () => {
  const stories = [...fx.stories];
  for (const f of await fs.readdir(new URL('../examples/', import.meta.url))) {
    stories.push(JSON.parse(await fs.readFile(new URL(`../examples/${f}`, import.meta.url), 'utf8')).story);
  }
  for (const story of stories) {
    const r = draftRuleBased(story, { date: '2026-11-12' });
    assert.equal(r.insufficient, true, story);
    assert.deepEqual(r.episode.rows, [], story);
    assert.equal(r.episode.post.text, '');
    const v = validateSafeEpisode(r.episode, story);
    assert.equal(v.ok, false, 'нехватка не уходит в ролик');
    assert.ok(v.errors.some((e) => e.path === 'rows'));
  }
  assert.equal(LIMITS.rowsMin, 2);
  // makeDraft без ключей — та же нехватка
  const md = await makeDraft('Утром я пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.', { provider: 'manual' });
  assert.equal(md.insufficient, true);
  assert.equal(md.episode.rows.length, 0);
});

/** Бот с вымышленным рассказом; строки человек пишет сам (+ или N:). */
async function withBot(fn) {
  const tg = fakeTelegram();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-vr-v1-'));
  const rendered = [];
  const render = async (ep, opts) => { rendered.push({ ep, opts }); await fs.mkdir(path.dirname(opts.outPath), { recursive: true }); await fs.writeFile(opts.outPath, 'x'); return { outPath: opts.outPath, duration: 24, seconds: 1 }; };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: makeMetrics(path.join(dir, 'm.jsonl')), render, draft: (st, o) => makeDraft(st, { ...o, provider: 'manual' }) });
  const chat = { id: 91, type: 'private' };
  const say = (text) => bot.handleUpdate({ message: { chat, text } });
  const play = (id) => bot.handleUpdate({ callback_query: { id, data: `play:${playId(tg)}`, message: { chat } } });
  try { await fn({ tg, say, play, rendered }); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('бот (решение 3б): правка «2: вечером гуляла в парке» — слова человека, строка принята без ⚠ (настоящий createBot)', async () => {
  await withBot(async ({ tg, say, play, rendered }) => {
    await say('Утром я пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.');
    await say('+ Утром — пила чай');
    await say('+ Днём — мыла посуду');
    await say('2: вечером гуляла в парке');
    assert.doesNotMatch(tg.sent.at(-1).text, /⚠/, tg.sent.at(-1).text);
    await play('a');
    assert.equal(rendered.length, 1);
    assert.deepEqual(rendered[0].ep.rows[1], { role: 'Вечером', value: 'гуляла в парке', source: 'вечером гуляла в парке', own: true });
  });
});

test('бот: правка — собственные слова человека; дословность — по тексту правки, признаки рассказа на неё не переходят', async () => {
  await withBot(async ({ tg, say, play, rendered }) => {
    // рассказ со сном и чужими словами: правка всё равно принимается — это слова самого человека
    await say('Мне снилось море. Мама сказала. Я пила чай.');
    for (const e of ['+ Утром — пила чай', '+ Мама — пекла пироги', '+ Чай — пила', '2: я гуляла в парке с собакой']) {
      await say(e);
      assert.doesNotMatch(tg.sent.at(-1).text, /⚠ Строка/, e);
    }
    await play('b');
    assert.equal(rendered.length, 1);
    assert.ok(rendered[0].ep.rows.every((r) => r.source && rowWordsGrounded(r, r.source)));
    // слово строки не из текста правки — нельзя (слова строки ⊂ слова правки)
    const ep = sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
      { role: 'Утром', value: 'пила кофе', source: 'Утром пила чай' }, { role: 'Днём', value: 'мыла посуду', source: 'Днём мыла посуду' }] });
    const v = validateEpisode(ep, `Я пила чай.${EDIT_SEP}Утром пила чай${EDIT_SEP}Днём мыла посуду`);
    assert.ok(v.errors.some((e) => e.path === 'rows.0.value' && /«кофе»/.test(e.msg)));
  });
});

test('бот: «N: текст» — роль и значение из слов текста правки; пару не собрать — без прежней роли, ошибка понятным текстом', () => {
  const ep = sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром пила чай' }, { role: 'Днём', value: 'мыла посуду', source: 'Днём мыла посуду' }] });
  assert.equal(applyEdit(ep, parseEdit('2: вечером гуляла в парке')), null);
  assert.deepEqual(ep.rows[1], { role: 'Вечером', value: 'гуляла в парке', source: 'вечером гуляла в парке', own: true });
  assert.equal(applyEdit(ep, parseEdit('1: работала')), null);
  const v = validateEpisode(ep, `Утром пила чай${EDIT_SEP}вечером гуляла в парке${EDIT_SEP}работала`);
  const msg = draftMessage(ep, v);
  assert.match(msg, /Строка 1: нет роли\. Напиши её так: «1: роль — текст»/);
  assert.doesNotMatch(msg, /цитат|утром/i);
  // сон и «почти»: пару не собрать — прежняя роль («Утром») не остаётся и не называется «словом не из рассказа»
  for (const t of ['2: мне снилось что я летала', '2: почти уснула за рулём']) {
    const e2 = sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
      { role: 'Днём', value: 'мыла посуду', source: 'Днём мыла посуду' }, { role: 'Утром', value: 'пила чай', source: 'Утром пила чай' }] });
    assert.equal(applyEdit(e2, parseEdit(t)), null);
    const m = draftMessage(e2, validateEpisode(e2, `Днём мыла посуду${EDIT_SEP}${parseEdit(t).value}`));
    assert.match(m, /Строка 2: нет роли/, t);
    assert.doesNotMatch(m, /«утром»/, t);
  }
});

test('бот (разбор 4196cbf): правка, дословно стоящая в рассказе, не получает признаки рассказа (настоящий createBot)', async () => {
  for (const [story, edit] of [
    ['Мама сказала. Я пила чай. Днём я мыла посуду.', '+ Я — пила чай'],
    ['Мне снилось, что вечером гуляла в парке. Днём я мыла посуду. Утром я пила чай.', '+ Вечером — гуляла в парке'],
    ['Если бы вечером гуляла в парке. Днём я мыла посуду. Утром я пила чай.', '+ Вечером — гуляла в парке'],
    ['Я не пила чай. Днём я мыла посуду. Утром я ела кашу.', '+ Пила — чай'],
  ]) {
    await withBot(async ({ tg, say, play, rendered }) => {
      await say(story);
      await say('+ Днём — мыла посуду');
      await say(edit);
      assert.doesNotMatch(tg.sent.at(-1).text, /⚠ Строка/, `${story} | ${edit}: ${tg.sent.at(-1).text}`);
      await play('c');
      assert.equal(rendered.length, 1, edit);
    });
  }
});

test('правка не меняет проверку строки модели: признаки и «не» из правки на неё не переходят, обрезку не снимают', () => {
  const ep = (row) => sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
    row, { role: 'Днём', value: 'мыла посуду', source: 'Днём я мыла посуду' }] });
  const story = 'Утром я пила чай. Днём я мыла посуду.';
  const row = { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' };
  // правка со сном или чужими словами, где дословно стоит цитата строки модели, — строка модели годится
  for (const edit of ['Мне снилось утром я пила чай', 'Мама сказала утром я пила чай']) {
    assert.deepEqual(validateEpisode(ep(row), `${story}${EDIT_SEP}${edit}`).errors, [], edit);
  }
  // строка модели, обрезанная в рассказе после «не», правкой без «не» не «воскресает»
  const cut = { role: 'Пила', value: 'чай', source: 'пила чай' };
  const told = 'Утром я не пила чай. Днём я мыла посуду.';
  assert.equal(validateEpisode(ep(cut), told).ok, false);
  assert.equal(validateEpisode(ep(cut), `${told}${EDIT_SEP}Утром — пила чай с мамой`).ok, false);
  // строка модели со сном в рассказе правкой без сна не «очищается» (строка 2 стоит до сна и сама годится);
  // совпадение цитаты с текстом любой правки («+», «название:», «после:», «в главной роли:») строку модели не освобождает
  const dream = { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' };
  const dreamStory = 'Днём я мыла посуду. Мне снилось, что утром я пила чай.';
  for (const edit of ['', `${EDIT_SEP}Утром я пила чай`, `${EDIT_SEP}Утром — я пила чай`]) {
    const v = validateEpisode(ep(dream), `${dreamStory}${edit}`);
    assert.ok(v.errors.length && v.errors.every((e) => e.path.startsWith('rows.0.')), `${edit}: ${JSON.stringify(v.errors)}`);
  }
  const cutStory = 'Утром я не пила чай. Днём я мыла посуду.';
  for (const edit of ['пила чай', 'Пила — чай']) {
    const v = validateEpisode(ep(cut), `${cutStory}${EDIT_SEP}${edit}`);
    assert.ok(v.errors.some((e) => e.path.startsWith('rows.0.')) && v.errors.every((e) => e.path.startsWith('rows.0.')), `${edit}: ${JSON.stringify(v.errors)}`);
  }
  // та же строка с флагом правки человека (own) — его слова, проверяется по тексту правки
  assert.deepEqual(validateEpisode(ep({ ...dream, own: true }), `${dreamStory}${EDIT_SEP}Утром я пила чай`).errors, []);
  // флаг own без правки в опоре (монтажная) ничего не освобождает
  assert.equal(validateEpisode(ep({ ...dream, own: true }), dreamStory).ok, false);
});

test('бот: «название:», «после:», «в главной роли:» с текстом цитаты не освобождают строку модели (настоящий createBot)', async () => {
  await withBot(async ({ tg, say }) => {
    await say('Утром я не пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.');
    await say('+ Днём — мыла посуду');
    await say('+ Вечером — гуляла с собакой');
    for (const e of ['название: пила чай', 'после: пила чай', 'в главной роли: пила чай']) await say(e);
    // строка модели «Пила — чай» без флага own по такой опоре не годится
    const story = `Утром я не пила чай. Днём я мыла посуду.${EDIT_SEP}пила чай`;
    assert.ok(rowWordProblems({ role: 'Пила', value: 'чай', source: 'пила чай' }, story).length > 0);
    assert.doesNotMatch(tg.sent.at(-1).text, /⚠ Строка/);
  });
});

test('правила черновика модели (покрытие после удаления тестов белого списка): манера речи, «отрубилась», опровержения', () => {
  const ok = (story, row) => rowWordProblems(row, story).length === 0;
  const row = { role: 'Анализы', value: 'хорошие', source: 'Анализы хорошие' };
  // манера речи без сказанного в конце фразы не переносится на следующую; с адресатом или источником — переносится
  assert.equal(ok('Брат кричал. Анализы хорошие.', row), true);
  for (const lead of ['Брат орал на меня.', 'Я прочитала в газете.', 'Мама читала мне сказку.']) {
    assert.equal(ok(`${lead} Анализы хорошие.`, row), false, lead);
  }
  // «отрубилась» — сон: следующая фраза под признаком сна
  const tea = { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' };
  assert.equal(ok('Утром я пила чай.', tea), true);
  assert.equal(ok('Я отрубилась, и утром я пила чай.', tea), false);
  // опровержения: «Это неправда.» и «Но это был сон.» снимают сказанное раньше
  assert.equal(ok('Утром я пила чай. Это неправда.', tea), false);
  assert.equal(ok('Утром я пила чай. Днём я мыла посуду. Но это был сон.', tea), false);
});

test('разделитель правок не приходит из рассказа; проверка безопасности читает правку как продолжение рассказа', async () => {
  // черновик модели: разделитель в рассказе не снимает сон с цитаты
  const ep = sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
    { role: 'Купила', value: 'квартиру', source: 'Я купила квартиру' }, { role: 'Пила', value: 'кофе', source: 'Я пила кофе' }] });
  const { cleanInput } = await import('../engine/episode.js');
  assert.equal(validateEpisode(ep, cleanInput(`Мне приснился сон.${EDIT_SEP}Я купила квартиру. Я пила кофе.`)).ok, false);
  // безопасность: «Я хочу» + правка «умереть» — urgent
  assert.equal(assessEpisodeRisk(joinEdits(`Я так устала. Я хочу${EDIT_SEP}умереть`), ep).level, 'urgent');
});

test('сообщение об обрезке после «не» — понятным текстом, без «цитаты»', () => {
  const ep = sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
    { role: 'Пила', value: 'чай', source: 'пила чай' }, { role: 'Днём', value: 'мыла посуду', source: 'Днём я мыла посуду' }] });
  const v = validateEpisode(ep, 'Утром я не пила чай. Днём я мыла посуду.');
  assert.ok(v.errors.some((e) => e.kind === 'words:cut'), JSON.stringify(v.errors));
  const msg = draftMessage(ep, v);
  assert.match(msg, /Строка 1: в рассказе перед этими словами стоит «не» или похожее слово/);
  assert.doesNotMatch(msg, /цитат/);
});

test('сцена после титров (разбор 66adcc7): слова — из её цитаты, признаки не оторваны; черновик модели и правка в боте', () => {
  const STORY2 = 'Утром я пила чай. Днём я мыла посуду. Посуду домою завтра. Мне снилось, что я отдохнула.';
  const ep = (post) => sanitizeEpisode({ date: '2026-11-12', title: 'Т', genre: 'камерное кино', rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' }, { role: 'Днём', value: 'мыла посуду', source: 'Днём я мыла посуду' }], post });
  // пример разбора: текст не из цитаты — ошибка, и в монтажной, и в черновике модели
  const bad = { text: 'Я была счастлива весь день', source: 'Днём я мыла посуду' };
  const v = validateEpisode(ep(bad), STORY2);
  assert.ok(v.errors.some((e) => e.path === 'post.text' && e.kind === 'post:missing'), JSON.stringify(v.errors));
  assert.doesNotMatch(v.errors.find((e) => e.path === 'post.text').msg, /цитат/);
  const raw = { title: 'Т', genre: 'камерное кино', mood: 'quiet', rows: [
    { role: 'Утром', value: 'пила чай', source: 'Утром я пила чай' }, { role: 'Днём', value: 'мыла посуду', source: 'Днём я мыла посуду' }] };
  assert.equal(groundDraft({ ...raw, post: bad }, STORY2).episode.post.text, '');
  // признак сна не отрывается
  const dream = { text: 'Отдохнула', source: 'я отдохнула' };
  assert.equal(validateEpisode(ep(dream), STORY2).ok, false);
  assert.equal(groundDraft({ ...raw, post: dream }, STORY2).episode.post.text, '');
  // слова из цитаты в форме рассказчика — годится
  const good = { text: 'Посуду домою завтра', source: 'Посуду домою завтра' };
  assert.deepEqual(validateEpisode(ep(good), STORY2).errors, []);
  assert.equal(groundDraft({ ...raw, post: good }, STORY2).episode.post.text, 'Посуду домою завтра');
  // правка «после: …» в боте — слова человека (own), проверяется по тексту правки
  const e2 = ep(good);
  assert.equal(applyEdit(e2, parseEdit('после: отдохнула во сне')), null);
  assert.equal(e2.post.own, true);
  assert.deepEqual(validateEpisode(sanitizeEpisode(e2), `${STORY2}${EDIT_SEP}отдохнула во сне`).errors, []);
});

test('строка модели (без own) — только по рассказу: цитата, которая есть лишь в правке, ей не опора (разбор 66adcc7)', () => {
  const row = { role: 'Вечером', value: 'гуляла', source: 'Вечером гуляла' };
  const story = `Утром я пила чай.${EDIT_SEP}Вечером гуляла в парке`;
  assert.ok(rowWordProblems(row, story).some((p) => p.kind === 'absent'));
  assert.deepEqual(rowWordProblems({ ...row, own: true, source: 'Вечером гуляла в парке' }, story), []);
});

test('бот: правка «после: …» длиннее предела — понятная ошибка длины, а не «слова не из рассказа» (разбор 49c6bf3)', async () => {
  await withBot(async ({ tg, say }) => {
    await say('Утром я пила чай. Днём я мыла посуду. Вечером я гуляла с собакой.');
    await say('+ Утром — пила чай');
    await say('+ Днём — мыла посуду');
    const long = 'после: вечером я долго сидела на балконе и смотрела как темнеет небо над крышами домов';
    assert.ok(long.length - 'после: '.length > LIMITS.post);
    await say(long);
    const msg = tg.sent.at(-1).text;
    assert.match(msg, new RegExp(`Сцена после титров длиннее ${LIMITS.post} знаков`), msg);
    assert.doesNotMatch(msg, /не складываются|цитат/, msg);
    await say('после: вечером сидела на балконе');
    assert.doesNotMatch(tg.sent.at(-1).text, /⚠/, tg.sent.at(-1).text);
  });
});
