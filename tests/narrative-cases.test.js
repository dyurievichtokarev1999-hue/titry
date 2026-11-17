// Набор 15 историй редактора: то, что можно проверить без модели, — целостность и определение рода.
// Смысловая проверка черновиков модели (keep/avoid) — отдельный прогон с ключом, см. evals/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectGender, sourceFound } from '../engine/episode.js';

const { cases } = JSON.parse(fs.readFileSync(new URL('../evals/narrative-cases.v1.json', import.meta.url), 'utf8'));

test('набор: 15 уникальных историй', () => {
  assert.equal(cases.length, 15);
  assert.equal(new Set(cases.map((c) => c.id)).size, 15);
});

test('каждая цитата-источник дословно есть в своём рассказе', () => {
  for (const c of cases) for (const src of c.sources) assert.ok(sourceFound(src, c.story), `${c.id}: «${src}»`);
});

test('род определяется только из собственных слов рассказчика', () => {
  for (const c of cases) {
    const allowed = Array.isArray(c.gender) ? c.gender : [c.gender];
    assert.ok(allowed.includes(detectGender(c.story)), `${c.id}: ожидалось ${JSON.stringify(c.gender)}, получено ${detectGender(c.story)}`);
  }
});
