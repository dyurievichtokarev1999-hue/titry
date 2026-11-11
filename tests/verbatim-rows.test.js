// Правило «слова строки — только из её цитаты» (владелец вместе с редактором, ответ 11.11 09:05).
// Все тексты — вымышленные (tests/fixtures/verbatim-rows.json и examples/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, rowWordProblems, rowWordsGrounded, sanitizeEpisode, validateEpisode } from '../engine/episode.js';
import { validateSafeEpisode } from '../server/safety.js';
import { draftRuleBased, draftWithClaude, groundDraft, makeDraft, SYSTEM_PROMPT } from '../server/draft.js';
import { applyEdit, createBot, makeMetrics } from '../server/bot.js';
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

test('заготовка без ИИ: «не» остаётся при слове, время — в роли', () => {
  const r = draftRuleBased('Я не пила чай. Утром работа.', { date: '2026-11-11' });
  assert.deepEqual(r.episode.rows.map((x) => `${x.role} — ${x.value}`), ['Чай — не пила', 'Утром — работа']);
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
    // только новый текст: прежней роли «Утром» в нём нет → ошибка в черновике, ролик не собирается
    await bot.handleUpdate({ message: { chat, text: '1: тихая работа' } });
    assert.match(tg.sent.at(-1).text, /в цитате нет слова «утром»/);
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
