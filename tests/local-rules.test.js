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
const oi = JSON.parse(await fs.readFile(new URL('./fixtures/oi-intent.json', import.meta.url), 'utf8'));

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

// Решение Claude 11.11: узкая форма «[близкий] меня убьёт за [что-то]» без признаков реальной опасности — concern
// (ролик возможен, предложение не попадает в титры). Остальные «сознательно строже» — urgent, как прежде.
const HYPER_OK = new Set(['Мама меня убьёт за опоздание.', 'Начальник убьёт меня за этот отчёт.', 'Бабушка убьёт меня за разбитую чашку, шучу.']);
test('Сознательно строже: угроза с поводом и прощание без уточнений останавливаются; узкая гипербола «меня убьёт за» — concern', () => {
  assert.deepEqual(sets.stricter.phrases.filter((t) => !HYPER_OK.has(t) && lv(t) !== 'urgent'), []);
  for (const t of HYPER_OK) assert.equal(lv(t), 'concern', t);
});

test('Гипербола «меня убьёт за»: любой признак реальной опасности рядом — urgent', () => {
  for (const t of ['Сестра грозится убить меня за спойлер.', 'Отец меня убьёт за двойку, в прошлый раз ремнём бил.', 'Мама меня убьёт за опоздание, боюсь идти домой.',
    'Мама меня убьёт за опоздание. Не хочу жить.', 'Отчим меня убьёт.', 'Мама опять меня убьёт за опоздание.', 'Мама меня убьёт за то, что я живу.',
    'Папа меня убьёт за разбитую машину, у меня синяки с прошлой недели.', 'Муж убьёт меня за ужин, он бьёт меня.']) assert.equal(lv(t), 'urgent', t);
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

// Блокер 1 независимого разбора 1c75040: признаки реальной опасности рядом с «меня убьёт за» — urgent (белый список).
test('Гипербола «меня убьёт за»: синонимы и будущее время побоев, травмы, оружие, удержание, страх, «всерьёз», партнёр, хроника — urgent', () => {
  for (const t of ['Отец меня убьёт за двойку, он меня лупит.', 'Папа меня убьёт за двойку и выпорет.', 'Мама меня убьёт за опоздание, она меня потом побьёт.',
    'Отец меня убьёт за двойку, он ударит меня.', 'Папа меня убьёт за прогул, он пинает меня ногами.', 'Мама меня убьёт за ключи, она кидается с кулаками.',
    'Отец меня убьёт за двойку. Он пьёт и дерётся.', 'Отец меня убьёт за разбитую машину, в тот раз он сломал мне руку.',
    'Отец меня убьёт за двойку, прошлый раз я неделю ходила в гипсе.', 'Брат меня убьёт за телефон, у него нож.',
    'Мама меня убьёт за опоздание, она меня запирает в ванной.', 'Предки меня убьют за татуировку, они меня выгонят на улицу.',
    'Мама меня убьёт за опоздание, мне страшно возвращаться.', 'Отец меня убьёт за двойку, я ночую у подруги, домой не пойду.',
    'Отец меня убьёт за двойку — и это не шутка.', 'Муж меня убьёт за опоздание.', 'Жена меня убьёт за ужин.', 'Муж меня убьёт за то, что я позвонила в полицию.',
    'Отец меня убьёт за любую мелочь.', 'Отец меня убьёт за что угодно.', 'Мама меня убьёт за то что я вообще живу.', 'Мама убьёт меня за то, что я дышу.',
    'Отец меня убьёт за само моё существование.', 'Мама меня убьёт за опоздание.\nУ меня синяки.']) assert.equal(lv(t), 'urgent', t);
});

test('Гипербола: структурный признак — вне формы кто-то действует на рассказчика; другие формы угрозы себе — urgent', () => {
  for (const t of ['Отец меня убьёт за двойку, он меня колотит.', 'Брат меня убьёт за телефон, он держал меня за горло.', 'Отец меня убьёт за двойку, он тушил об меня сигареты.',
    'Мама меня убьёт за опоздание, она оставит меня без еды на три дня.', 'Отец меня убьёт за двойку, он уже задушил кошку.', 'Папа меня убьёт за двойку, вчера отхлестал проводом.',
    'Отец меня убьёт за двойку, буквально.', 'Меня отец убьёт за двойку, он вчера сломал мне руку.', 'Отец убьёт за двойку, он меня колотит.',
    'Мама прибьёт меня за опоздание.', 'Отец меня прибьёт за двойку, у него ружьё.', 'Подруга меня убьёт за измену.', 'Мама меня убьёт за это.']) assert.equal(lv(t), 'urgent', t);
  for (const t of ['Шеф меня убьёт за отчёт.', 'Свекровь меня убьёт за пересоленный борщ.', 'Начальник меня убьёт за этот отчёт, но день был отличный.']) assert.equal(lv(t), 'concern', t);
});

// Ответ Claude 11.11 03:59 и КОД-РЕВЬЮ QA на 1c750409: инвариант монотонности исключения гиперболы.
const QH = ['Мама меня убьёт за опоздание. Она уже взяла нож и ждёт меня дома.', 'Мама меня убьёт за опоздание. У неё в руках пистолет.',
  'Мама меня убьёт за опоздание. Она уже приготовила нож.'];
test('QH01/QH02/QH04 и классы «предмет-оружие × действие» рядом с гиперболой — urgent; QC01 — concern; QC02 — urgent', () => {
  for (const t of QH) assert.equal(lv(t), 'urgent', t);
  const weapons = ['нож', 'пистолет', 'биту', 'топор', 'молоток', 'отвёртку', 'ружьё', 'кастет', 'ремень', 'верёвку', 'арматуру', 'кочергу', 'бритву'];
  const acts = ['Она уже взяла', 'Папа держит', 'Дома ждут с чем-то: взяли', 'Брат приготовил', 'У неё в руках'];
  for (const w of weapons) for (const a of acts) {
    const t = `Мама меня убьёт за опоздание. ${a} ${w}.`;
    assert.equal(lv(t), 'urgent', t);
  }
  assert.equal(lv('Мама меня убьёт за опоздание.'), 'concern', 'QC01');
  assert.equal(lv('Мама меня убьёт за опоздание, боюсь идти домой.'), 'urgent', 'QC02');
});

test('Свойство: для любого рассказа S открытых наборов и допустимой гиперболы H уровень(S + H) ≥ уровень(S), в обоих порядках', () => {
  const R = { none: 0, concern: 1, urgent: 2 };
  const H = ['Мама меня убьёт за опоздание.', 'Начальник убьёт меня за этот отчёт.', 'Бабушка убьёт меня за разбитую чашку, шучу.'];
  const S = [...sets.paraphrases, ...sets.everyday, ...sets.stricter.phrases, ...oi.cases.map((c) => c.text), ...QH];
  const down = [];
  for (const s of S) for (const h of H) for (const t of [`${s} ${h}`, `${h} ${s}`]) if (R[lv(t)] < R[lv(s)]) down.push(t);
  assert.deepEqual(down, []);
});

test('QH/QC/QF через настоящий /api/render (вариант QA: без «обещаний» и строки «Выводы»): QH — 422, рендер 0 при разрешающей модели', async () => {
  const story0 = ex.story.replace(/\s*Я хочу закончить здесь, без выводов и обещаний на завтра\.$/, '');
  assert.ok(!/обеща/.test(story0));
  const episode = { ...structuredClone(ex.episode), rows: ex.episode.rows.filter((r) => r.role !== 'Выводы') };
  const run = async (extra, safetyCheck) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-qh-'));
    let renders = 0;
    const server = createApp({ dataDir, safetyCheck, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: `${story0} ${extra}`, episode }) });
      return { status: res.status, body: await res.json(), renders };
    } finally { server.closeAllConnections(); server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
  };
  const allow = async () => false;
  for (const q of QH) {
    const r = await run(q.replace('Мама меня убьёт за опоздание. ', 'Мама меня убьёт за опоздание. '), allow);
    assert.equal(r.status, 422, q); assert.equal(r.body.kind, 'safety', q); assert.equal(r.renders, 0, q);
  }
  const qc01 = await run('Мама меня убьёт за опоздание.', allow);
  assert.equal(qc01.status, 200, 'QC01'); assert.equal(qc01.renders, 1);
  const qc02 = await run('Мама меня убьёт за опоздание, боюсь идти домой.', allow);
  assert.equal(qc02.status, 422, 'QC02'); assert.equal(qc02.renders, 0);
  const qf01 = await run(QH[0], async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); });
  assert.ok([422, 503].includes(qf01.status), 'QF01: без выдачи'); assert.equal(qf01.renders, 0);
  const qf01b = await run('Мама меня убьёт за опоздание.', async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); });
  assert.equal(qf01b.status, 503, 'недоступность проверки — 503'); assert.equal(qf01b.renders, 0);
});
