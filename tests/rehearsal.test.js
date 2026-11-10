// ИР-05: «Репетиция» R16–R20 и H/S редактора повествования (вымышленные случаи, rehearsal/r16-r20.json).
// Проверяется то, что уже выполняется; известные пробелы — test.todo с причиной (видны в каждом прогоне,
// не скрыты и не выданы за прохождение). Правила фильтра здесь не меняются — это особая зона и решение людей.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runCase } from '../scripts/rehearsal-report.js';
import { assessRisk } from '../server/safety.js';

const data = JSON.parse(await fs.readFile(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));

test('данные: пять случаев, у каждой строки цитата дословно из рассказа, поля по схеме', () => {
  assert.deepEqual(data.cases.map((c) => c.id), ['R16', 'R17', 'R18', 'R19', 'R20']);
  for (const c of data.cases) for (const v of ['good', 'bad']) {
    const raw = c[v];
    for (const k of ['title', 'genre', 'mood', 'grammatical_gender', 'safety_flag', 'rows', 'post']) assert.ok(k in raw, `${c.id}.${v}.${k}`);
    for (const r of raw.rows) assert.ok(c.story.includes(r.source), `${c.id}.${v}: ${r.role}`);
  }
  assert.equal(data.hyperbole.length, 20);
  assert.equal(data.stop.length, 20);
});

test('R16–R19: эталонный ответ модели даёт черновик, проходящий проверку', async () => {
  for (const c of data.cases.filter((x) => x.expect === 'reject')) {
    const r = await runCase(c, 'good');
    assert.equal(r.status, 'draft', c.id);
    assert.equal(r.valid, true, c.id);
  }
});

test('R20: эталонный ответ модели (safety_flag) — остановка без эпизода', async () => {
  const c = data.cases.find((x) => x.id === 'R20');
  assert.equal((await runCase(c, 'good')).status, 'stopped');
});

test('S11 и S19 останавливаются локальным фильтром (без модели)', () => {
  for (const id of ['S11', 'S19']) assert.equal(assessRisk(data.stop.find((s) => s.id === id).text).level, 'urgent', id);
});

test('отчёт репетиции печатает только ID и статусы — без текстов рассказов', () => {
  const out = execFileSync(process.execPath, [new URL('../scripts/rehearsal-report.js', import.meta.url).pathname]).toString();
  for (const c of data.cases) assert.ok(!out.includes(c.story.slice(0, 25)), c.id);
  for (const s of [...data.stop, ...data.hyperbole]) assert.ok(!out.includes(s.text.slice(0, 25)), s.id);
});

// Известные пробелы (найдены этим прогоном 10.11). Закрываются только решением людей об особой зоне.
test.todo('R20: неверный ответ модели (safety_flag: false) должен остановиться без ролика — сейчас даёт черновик');
test.todo('S01–S20: локальный фильтр должен останавливать все — сейчас 2/20 (S11, S19); остальные держит только флаг модели');
test.todo('H+S: девять сочетаний H01/H02/H04 × S01/S02/S04 должны останавливаться — сейчас 0/9 локально');
test.todo('R16–R19: неверный ответ проходит автоматические проверки — отклоняет организатор в «Репетиции» (режим интерфейса — следующий шаг)');

