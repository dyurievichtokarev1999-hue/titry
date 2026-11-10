// L01/L02 (матрица QA 13:29; решение владельца «в»): локальные правила по группам S редактора повествования
// и проверка гипербол H на ложные срабатывания. Фикстуры — вымышленные (rehearsal/r16-r20.json).
// H — не разрешающий список: проверяется, что правила S их не задевают, и что H рядом с S не ослабляет остановку.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessRisk } from '../server/safety.js';
import { createApp } from '../server/app.js';

const data = JSON.parse(await fs.readFile(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));
const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const lv = (t) => assessRisk(t).level;
const sets = JSON.parse(await fs.readFile(new URL('./fixtures/local-rules-sets.json', import.meta.url), 'utf8'));

test('L01: все 20 сигналов S останавливаются локальным фильтром (без модели)', () => {
  const missed = data.stop.filter((s) => lv(s.text) !== 'urgent').map((s) => s.id);
  assert.deepEqual(missed, []);
});

test('L02: ни одна гипербола H не останавливается и не даёт concern', () => {
  const hit = data.hyperbole.filter((h) => lv(h.text) !== 'none').map((h) => `${h.id}=${lv(h.text)}`);
  assert.deepEqual(hit, [], 'срабатывания H сдаются редактору, ожидания не переписываются');
});

// Контроль переобучения (замечание независимого разбора): перефразы групп S, написанные отдельно от фикстур,
// и бытовые фразы с теми же словами. Разбор на первой версии правил: перефразы 25/80, бытовые 36/42 ложных.
test('L01: перефразы групп S (не фикстуры) останавливаются', () => {
  assert.deepEqual(sets.paraphrases.filter((t) => lv(t) !== 'urgent'), []);
});

test('L02: бытовые фразы со словами-похожими не останавливаются', () => {
  assert.deepEqual(sets.everyday.filter((t) => lv(t) !== 'none').map((t) => `${t} => ${lv(t)}`), []);
});

test('L01: длинный текст (6000 знаков из повторов) проверяется быстро — без катастрофического бэктрекинга', () => {
  for (const chunk of ['легче всем без меня ', 'не хочу больше ', 'без меня на ', 'бьет меня по плечу ', 'а'.repeat(50) + ' ']) {
    const t = chunk.repeat(Math.ceil(6000 / chunk.length)).slice(0, 6000);
    const start = performance.now();
    assessRisk(t);
    assert.ok(performance.now() - start < 200, chunk);
  }
});

test('L02: H рядом с S не ослабляет остановку — все 400 сочетаний в обоих порядках', () => {
  const miss = [];
  for (const h of data.hyperbole) for (const s of data.stop) {
    if (lv(`${h.text} ${s.text}`) !== 'urgent') miss.push(`${h.id}+${s.id}`);
    if (lv(`${s.text} ${h.text}`) !== 'urgent') miss.push(`${s.id}+${h.id}`);
  }
  assert.deepEqual(miss, []);
});

test('R16–R19 не останавливаются, R20 останавливается локально (даже если модель ошиблась)', () => {
  for (const c of data.cases) assert.equal(lv(c.story), c.expect === 'stop' ? 'urgent' : 'none', c.id);
});

test('L01 маршрут: монтажная при «разрешающих» модельных слоях — S и R20: 422/safety, render 0; H: 200, render 1', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-l01-'));
  let renders = 0;
  // Худший случай для локального слоя: отдельная проверка всегда «false» (модель пропустила).
  const server = createApp({ dataDir, safetyCheck: async () => false, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const render = async (extra) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: `${ex.story} ${extra}`, episode: ex.episode }) });
    return { status: res.status, body: await res.json() };
  };
  try {
    for (const s of [...data.stop, data.cases.find((c) => c.id === 'R20')]) {
      const before = renders;
      const r = await render(s.text || s.story);
      assert.equal(r.status, 422, s.id); assert.equal(r.body.kind, 'safety', s.id);
      assert.equal(renders, before, `${s.id}: render 0`);
    }
    for (const h of data.hyperbole) {
      const before = renders;
      const r = await render(h.text);
      assert.equal(r.status, 200, h.id); assert.equal(renders, before + 1, `${h.id}: render 1`);
    }
  } finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
