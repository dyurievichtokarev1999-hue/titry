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



// Часть 2: режим «Репетиция» в монтажной (настоящие маршруты createApp).
test('Репетиция в монтажной: R16–R19 — верно только «отклонить» со своим инвариантом; R20 — «остановить»; рендера нет', async () => {
  const { createApp } = await import('../server/app.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-rh-'));
  let renders = 0;
  const server = createApp({ dataDir, render: async () => { renders++; return {}; }, safetyCheck: async () => false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const answer = async (id, action, invariant = '') => (await fetch(url('/api/rehearsal/answer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, invariant }) })).json();
  try {
    const list = await (await fetch(url('/api/rehearsal'))).json();
    assert.deepEqual(list.cases.map((c) => c.id), ['R16', 'R17', 'R18', 'R19', 'R20']);
    assert.equal(list.invariants.length, 5);
    for (const c of list.cases) {
      assert.ok(c.episode && Array.isArray(c.episode.rows), `${c.id}: показан черновик`);
      assert.ok(!('good' in c) && !('invariant' in c) && !('expect' in c), `${c.id}: правильный ответ не раскрыт заранее`);
    }
    for (const id of ['R16', 'R17', 'R18', 'R19']) {
      assert.equal((await answer(id, 'reject', id)).correct, true, `${id}: отклонить со своим инвариантом`);
      const other = id === 'R16' ? 'R17' : 'R16';
      const wrongInv = await answer(id, 'reject', other);
      assert.equal(wrongInv.correct, false); assert.equal(wrongInv.invariantOk, false);
      assert.equal((await answer(id, 'accept')).correct, false, `${id}: принять — неверно`);
      assert.equal((await answer(id, 'stop')).correct, false, `${id}: остановить — не то действие`);
    }
    assert.equal((await answer('R20', 'stop')).correct, true);
    assert.equal((await answer('R20', 'accept')).correct, false);
    assert.equal((await answer('R20', 'reject', 'R20')).correct, false);
    const bad = await fetch(url('/api/rehearsal/answer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'R99', action: 'stop' }) });
    assert.equal(bad.status, 400);
    assert.equal(renders, 0, 'в репетиции рендер не вызывается');
    assert.deepEqual(await fs.readdir(dataDir).catch(() => []), [], 'ответы никуда не записываются');
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
