// Признаки намерения OI01–OI12 (редактор повествования, 11.11 00:32) и правило «угроза не становится титром».
// Тесты асимметричные (решение владельца 00:59): OI01–OI06 — строго urgent; OI07–OI12 — не ниже concern,
// urgent допустим и печатается отдельной строкой «ложная остановка», а не считается провалом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessRisk, threatErrors, validateSafeEpisode } from '../server/safety.js';
import { groundDraft, draftRuleBased } from '../server/draft.js';
import { createApp } from '../server/app.js';

const oi = JSON.parse(await fs.readFile(new URL('./fixtures/oi-intent.json', import.meta.url), 'utf8')).cases;
const lv = (t) => assessRisk(t).level;

test('OI01–OI06: намерение причинить вред другому — urgent', () => {
  for (const c of oi.filter((x) => x.expected_reading === 'urgent')) assert.equal(lv(c.text), 'urgent', c.id);
});

test('OI07–OI12: голая фраза гнева — не ниже concern (urgent фиксируется как ложная остановка)', (t) => {
  for (const c of oi.filter((x) => x.expected_reading === 'concern')) {
    const got = lv(c.text);
    assert.notEqual(got, 'none', c.id);
    if (got === 'urgent') t.diagnostic(`ложная остановка относительно разметки: ${c.id}`);
  }
});

test('Контроль: «убить время», «решил закончить разговор», «хочу ударить по мячу» — не угроза человеку', () => {
  for (const s of ['Решил убить время до поезда за книгой.', 'Я решил закончить разговор.', 'Сегодня хочу убить вечер на сериал.']) assert.equal(lv(s), 'none', s);
});

const STORY = 'Утром был дождь. Я злюсь и хочу убить мужа. Вечером пила чай на кухне. Кот спал на подоконнике.';

test('Угроза не в титрах: черновик модели — строки, пост и название с опорой на угрозу отбрасываются', () => {
  const raw = {
    title: 'Хочу убить мужа', genre: 'камерное кино', mood: 'quiet', grammatical_gender: 'f', safety_flag: false,
    rows: [
      { role: 'Муж', value: 'убить', source: 'Я злюсь и хочу убить мужа' },
      { role: 'Дождь', value: 'утром', source: 'Утром был дождь' },
      { role: 'Чай', value: 'на кухне', source: 'Вечером пила чай на кухне' },
    ],
    post: { text: 'хочу убить мужа', source: 'хочу убить мужа' },
  };
  const { episode, dropped } = groundDraft(raw, STORY, { date: '2026-11-11' });
  assert.deepEqual(episode.rows.map((r) => r.role), ['Дождь', 'Чай']);
  assert.equal(episode.post.text, '');
  assert.equal(episode.title, '', 'название из угрозы не берётся');
  assert.ok(dropped.length >= 2);
  // Исходный рассказ для проверки безопасности не урезается: угроза по-прежнему видна фильтру.
  assert.equal(lv(STORY), 'concern');
});

test('Угроза не в титрах: заготовка без ИИ не берёт предложение с угрозой', () => {
  const { episode } = draftRuleBased(STORY, { date: '2026-11-11' });
  const all = [episode.title, ...episode.rows.flatMap((r) => [r.value, r.source]), episode.post.text].join(' | ');
  assert.doesNotMatch(all.toLowerCase(), /убить/);
});

test('Угроза не в титрах: ручная правка с угрозой — ошибка проверки; рендер в монтажной не запускается', async () => {
  const ep = {
    date: '2026-11-11', period: 'day', mood: 'quiet', music: 'quiet', title: 'Дождь и чай', genre: 'камерное кино',
    rows: [{ role: 'Дождь', value: 'утром', source: 'Утром был дождь' }, { role: 'Муж', value: 'хочу убить мужа', source: 'хочу убить мужа' }],
    post: { text: '', source: '' },
  };
  assert.deepEqual(threatErrors(STORY, ep).map((e) => e.path), ['rows.1']);
  assert.equal(validateSafeEpisode(ep, STORY).ok, false);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-threat-'));
  let renders = 0;
  const server = createApp({ dataDir, safetyCheck: async () => false, render: async () => { renders++; return { seconds: 1 }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: STORY, episode: ep }) });
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.ok(body.validation.errors.some((e) => e.path === 'rows.1'));
    assert.equal(renders, 0);
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('Угроза не в титрах: обычные примеры не задеты', async () => {
  for (const f of await fs.readdir(new URL('../examples/', import.meta.url))) {
    const ex = JSON.parse(await fs.readFile(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
    if (ex.story && ex.episode) assert.deepEqual(threatErrors(ex.story, ex.episode), [], f);
  }
});
