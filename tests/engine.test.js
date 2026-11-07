import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectGender, validateEpisode, sanitizeEpisode, dateLabel, creditRows, sourceFound, episodeToText } from '../engine/episode.js';

const examples = fs.readdirSync(new URL('../examples/', import.meta.url))
  .map((f) => JSON.parse(fs.readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8')));

test('все четыре примера проходят проверку без ошибок и предупреждений', () => {
  assert.equal(examples.length, 4);
  for (const ex of examples) {
    const v = validateEpisode(ex.episode, ex.story);
    assert.deepEqual(v.errors, [], ex.episode.title);
    assert.deepEqual(v.warnings, [], ex.episode.title);
  }
});

test('род определяется только по словам человека о себе', () => {
  assert.equal(detectGender('Сегодня я долго правил письмо.'), 'm');
  assert.equal(detectGender('Я так устала, что легла рано.'), 'f');
  assert.equal(detectGender('Я разозлилась на встрече.'), 'f');
  assert.equal(detectGender('Мне грустно. Хочу спать.'), null);
  assert.equal(detectGender('Я устал. Я устала.'), null, 'противоречие → неизвестно');
  assert.equal(detectGender('Маша сегодня отдыхала.'), null, 'по имени не угадываем');
});

test('строка без опоры в рассказе — ошибка', () => {
  const ex = structuredClone(examples.find((e) => e.episode.mood === 'warm'));
  ex.episode.rows[0].source = 'выиграл в лотерею миллион';
  const v = validateEpisode(ex.episode, ex.story);
  assert.equal(v.ok, false);
  assert.match(v.errors[0].msg, /не найдена в рассказе/);
});

test('сверка цитаты не зависит от регистра, ё и пунктуации', () => {
  assert.ok(sourceFound('Злость еще со мной', 'Злость ещё со мной. Я не хочу...'));
  assert.ok(!sourceFound('', 'что угодно'));
});

test('глагол прошедшего времени на «ты» без известного рода — предупреждение', () => {
  const ep = sanitizeEpisode({ ...examples[0].episode, gender: null, rows: [{ role: 'Работа', value: 'ты правил письмо' }, { role: 'Друг', value: 'вечерний звонок' }] });
  const v = validateEpisode(ep);
  assert.ok(v.warnings.some((w) => w.path === 'gender'));
  const v2 = validateEpisode({ ...ep, gender: 'm' });
  assert.ok(!v2.warnings.some((w) => w.path === 'gender'));
});

test('«финал», «конец» и навязанный позитив отмечаются', () => {
  const ep = sanitizeEpisode({ ...examples[0].episode, post: { text: 'Финал. Ты стала сильнее.', source: '' } });
  const msgs = validateEpisode(ep).warnings.map((w) => w.msg).join(' ');
  assert.match(msgs, /финал/);
  assert.match(msgs, /позитив/);
  const ok = sanitizeEpisode({ ...examples[0].episode, post: { text: 'Конец сцены.', source: '' } });
  assert.ok(!validateEpisode(ok).warnings.some((w) => /Конец/.test(w.msg)));
});

test('лимиты строк', () => {
  const base = examples[0].episode;
  const tooMany = { ...base, rows: Array.from({ length: 7 }, (_, i) => ({ role: `Роль${i}`, value: 'текст' })) };
  assert.equal(validateEpisode(tooMany).ok, false);
  const tooFew = { ...base, rows: [{ role: 'Одна', value: 'строка' }] };
  assert.equal(validateEpisode(tooFew).ok, false);
});

test('фиксированные строки титров и текстовая версия', () => {
  const rows = creditRows(examples[0].episode);
  assert.equal(rows[0].role, 'в главной роли');
  assert.equal(rows.at(-1).role, 'саундтрек');
  assert.equal(dateLabel('2026-11-02'), '2 ноября');
  assert.equal(dateLabel('2026-12-31', 'year'), '2026 год');
  assert.match(episodeToText(examples[0].episode), /Конец сцены\./);
});
