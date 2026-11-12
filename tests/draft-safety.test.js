import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, helpMessage, loadHelp } from '../server/safety.js';
import { draftRuleBased, draftWithClaude, groundDraft, makeDraft, SYSTEM_PROMPT } from '../server/draft.js';
import { validateEpisode } from '../engine/episode.js';

const STORY = 'Сегодня на встрече мой вопрос дважды перебили. Я разозлился и после встречи написал резкий черновик ответа, но не отправил его. Вместо этого вышел пройтись и вернулся домой. Злость ещё со мной.';

test('прямые слова о нежелании жить останавливают черновик', () => {
  for (const s of ['не хочу больше жить', 'Иногда думаю, что лучше бы меня не было', 'хочется умереть', 'опять режу себя']) {
    assert.equal(assessRisk(s).level, 'urgent', s);
  }
  assert.equal(assessRisk('Сегодня просто устал, хочу спать').level, 'none');
  assert.equal(assessRisk('Меня ударил сосед').level, 'urgent', 'опасность для самого человека — остановка');
  assert.equal(assessRisk('Убью его, если опять опоздает').level, 'concern', 'гнев на других — предупреждение');
  assert.equal(assessRisk('обычный день', true).level, 'urgent', 'флаг модели');
});

test('экран помощи показывает только подтверждённые контакты', () => {
  const help = loadHelp();
  assert.ok(help.contacts.every((c) => c.phone));
  assert.ok(help.contacts.some((c) => c.phone === '112'));
  const text = helpMessage('urgent', help);
  assert.match(text, /112/);
  assert.doesNotMatch(text, /2000-122/, 'неподтверждённый номер не показывается');
});

test('makeDraft не делает титры при срочном риске', async () => {
  const r = await makeDraft('Всё плохо. Я не хочу жить.', { provider: 'manual' });
  assert.equal(r.episode, null);
  assert.equal(r.risk.level, 'urgent');
  const r2 = await makeDraft('Всё плохо, весь день думал, что не хочу жить. Потом позвонил друг.', { provider: 'manual', continueAfterHelp: true });
  assert.equal(r2.episode, null, 'флаг продолжения остановку не отменяет');
});

test('заготовка без ИИ опирается на рассказ и угадывает плёнку по словам человека', () => {
  const { episode } = draftRuleBased(STORY, { date: '2026-11-04' });
  assert.equal(episode.mood, 'anger');
  assert.equal(episode.gender, 'm');
  const v = validateEpisode(episode, STORY);
  assert.deepEqual(v.errors.filter((e) => /не найдена/.test(e.msg)), []);
});

test('черновик модели: строки без дословной цитаты отбрасываются, род сверяется', () => {
  const raw = {
    title: 'Вопрос, который перебили', genre: 'драма без развязки', mood: 'anger', grammatical_gender: 'f', safety_flag: false,
    rows: [
      { role: 'Вопрос', value: 'дважды перебили', source: 'мой вопрос дважды перебили' },
      { role: 'Начальник', value: 'хотел унизить', source: 'начальник хотел меня унизить' },
      // во фразе есть «написал» — признак чужих или своих слов (владелец 11.11 13:05): строка берёт его
      { role: 'Резкий черновик', value: 'написал', source: 'написал резкий черновик ответа' },
    ],
    post: { text: 'Злость ещё со мной.', source: 'Злость ещё со мной' },
  };
  const { episode, dropped } = groundDraft(raw, STORY, { date: '2026-11-04' });
  assert.equal(episode.rows.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(episode.gender, null, 'модель сказала f, слова человека говорят m → род неизвестен');
  assert.equal(episode.post.text, 'Злость ещё со мной.');
  // слово сцены после титров не из её цитаты («здесь») — сцена отбрасывается (разбор 66adcc7)
  const other = groundDraft({ ...raw, post: { text: 'Злость ещё здесь.', source: 'Злость ещё со мной' } }, STORY, { date: '2026-11-04' });
  assert.equal(other.episode.post.text, '');
  assert.equal(other.dropped.length, 2);
});

test('draftWithClaude: запрос и разбор ответа (клиент подменён)', async () => {
  let req;
  const client = { beta: { messages: { create: async (r) => { req = r; return {
    model: r.model, stop_reason: 'end_turn', usage: {},
    content: [{ type: 'text', text: JSON.stringify({
      title: 'Вопрос, который перебили', genre: 'драма без развязки', mood: 'anger', grammatical_gender: 'm', safety_flag: false,
      rows: [
        { role: 'Вопрос', value: 'дважды перебили', source: 'мой вопрос дважды перебили' },
        { role: 'Черновик ответа', value: 'написал, но не отправил', source: 'написал резкий черновик ответа, но не отправил его' },
        { role: 'Злость', value: 'ещё со мной', source: 'Злость ещё со мной' },
      ],
      post: { text: '', source: '' },
    }) }],
  }; } } } };
  const r = await draftWithClaude(STORY, { client, tone: 'direct', date: '2026-11-04' });
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.system, SYSTEM_PROMPT);
  assert.match(req.messages[0].content, /прямой/);
  assert.equal(r.episode.rows.length, 3);
  assert.equal(r.episode.gender, 'm');
  assert.equal(validateEpisode(r.episode, STORY).ok, true);
});

test('draftWithClaude: отказ модели превращается в понятную ошибку', async () => {
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: null }, content: [] }) } } };
  await assert.rejects(draftWithClaude(STORY, { client }), (e) => e.code === 'refusal');
});
