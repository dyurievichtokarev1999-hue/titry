// Матрица приёмки QA 10.11 13:29 (S/U/T/V/L) — монтажная. Настоящий createApp; подставные: отдельная проверка,
// генератор (draft), часы, рендер. Только вымышленные истории (examples/day-quiet.json и URGENT из care-v02).
// ID теста совпадает с ID матрицы, чтобы отчёт PR можно было собрать по ним.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { modelSafetyCheck } from '../server/draft.js';
import { RETRY_AFTER_MS } from '../server/gate.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ep = () => structuredClone(ex.episode);
const STORY = ex.story;
const URGENT = 'Сегодня опять всё валится из рук. Я не хочу больше жить. Вечером позвонила сестра.';
const text = (t) => ({ type: 'text', text: t });
const sj = (flag) => JSON.stringify({ safety_flag: flag });
const viaModel = (resp) => (s) => modelSafetyCheck(s, { client: { beta: { messages: { create: async () => (typeof resp === 'function' ? resp() : resp) } } } });
const coded = (code) => async () => { throw Object.assign(new Error(`сбой ${code} МАРКЕР-L03`), { code }); };
const goodDraft = async () => ({ episode: ep(), validation: { ok: true }, risk: { level: 'none' }, provider: 'claude', dropped: [] });
const HELP = /помощ|112|телефон доверия/i;

async function withApp(opts, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-sc-'));
  const clock = { mono: 1_000, wall: Date.parse('2026-11-10T12:00:00Z') };
  const counters = { render: 0, check: 0 };
  const check = opts.check;
  const server = createApp({
    dataDir,
    draft: opts.draft || goodDraft,
    safetyCheck: async (t) => { counters.check++; return check(t, counters.check); },
    hasKey: opts.hasKey || (() => true),
    monoNow: () => clock.mono, wallNow: () => clock.wall,
    render: async (e, o) => { counters.render++; if (opts.render) return opts.render(e, o); return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const render = (story = STORY, episode = ep()) => post('/api/render', { story, episode });
  const recheck = (story = STORY, episode = ep()) => post('/api/recheck', { story, episode });
  const draft = (story = STORY) => post('/api/draft', { story });
  try { await fn({ post, render, recheck, draft, clock, counters }); }
  finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

const isSafety = (r) => r.status === 422 && r.body.kind === 'safety' && typeof r.body.help === 'string' && r.body.help.length > 0;
const isUnavailable = (r) => r.status === 503 && r.body.unavailable === true && !r.body.help && !r.body.risk && r.body.kind !== 'safety';
const isTechnical = (r) => r.status === 422 && r.body.kind === 'technical' && r.body.reason === 'check_incomplete_twice' && !r.body.help && !r.body.risk
  && !HELP.test(`${r.body.error} ${r.body.message} ${r.body.next}`) && !/опасн|тяж[её]л/i.test(`${r.body.error} ${r.body.message} ${r.body.next}`);

// ── 1. safety ───────────────────────────────────────────────────────────────

test('S01: локальный слой → 422/safety, нет генерации, проверки и рендера; запрет сохранён', async () => {
  let drafts = 0;
  await withApp({ check: () => false, draft: async (s) => { drafts++; return { episode: null, risk: { level: 'urgent', byModel: false, matches: ['x'] }, provider: null }; } }, async ({ draft, render, counters }) => {
    const d = await draft(URGENT);
    assert.ok(isSafety(d)); assert.equal(d.body.risk.byModel, false, 'byModel только у модельного слоя');
    const r = await render(URGENT);
    assert.ok(isSafety(r));
    assert.equal(counters.check, 0); assert.equal(counters.render, 0);
    // Тот же рассказ после остановки — черновик больше не запрашивается.
    assert.ok(isSafety(await draft(URGENT))); assert.equal(drafts, 1);
  });
});

test('S02: отдельная проверка true при разрешающем генераторе → 422/safety, render 0', async () => {
  await withApp({ check: () => true }, async ({ draft, render, counters }) => {
    assert.equal((await draft()).status, 200, 'генератор разрешил');
    assert.ok(isSafety(await render()));
    assert.ok(isSafety(await render()), 'повтор не снимает');
    assert.ok(isSafety(await draft()), 'черновик того же рассказа тоже остановлен');
    assert.equal(counters.render, 0);
  });
});

test('S03: генератор true при разрешающей отдельной проверке → 422/safety, render 0', async () => {
  await withApp({ check: () => false, draft: async () => ({ episode: null, risk: { level: 'urgent', byModel: true, matches: [] }, provider: 'claude' }) }, async ({ draft, render, counters }) => {
    const d = await draft();
    assert.ok(isSafety(d)); assert.equal(d.body.risk.byModel, true);
    assert.ok(isSafety(await render()));
    assert.equal(counters.check, 0, 'после остановки проверка не нужна'); assert.equal(counters.render, 0);
  });
});

test('S04: обрезанный ответ, успевший сказать true, — safety', async () => {
  for (const t of ['{"safety_flag": true', '{"safety_flag":true,']) {
    await withApp({ check: viaModel({ stop_reason: 'max_tokens', content: [text(t)] }) }, async ({ render, counters }) => {
      assert.ok(isSafety(await render()), t); assert.equal(counters.render, 0);
    });
  }
});

test('S04: true с max_tokens → safety; неразборчивый max_tokens — неполная проверка (503), не разрешение', async () => {
  await withApp({ check: viaModel({ stop_reason: 'max_tokens', content: [text(sj(true))] }) }, async ({ render, counters }) => {
    assert.ok(isSafety(await render())); assert.equal(counters.render, 0);
  });
  await withApp({ check: viaModel({ stop_reason: 'max_tokens', content: [text('{"safety_fl')] }) }, async ({ render, counters }) => {
    const r = await render();
    assert.ok(isUnavailable(r)); assert.equal(r.body.code, 'max_tokens'); assert.equal(counters.render, 0);
  });
});

// ── 2. первый технический сбой ──────────────────────────────────────────────

const U = {
  'U01 сеть': coded('ECONNRESET'),
  'U01 timeout': coded('timeout'),
  'U02 refusal': viaModel({ stop_reason: 'refusal', content: [text(sj(false))] }),
  'U03 max_tokens+false': viaModel({ stop_reason: 'max_tokens', content: [text(sj(false))] }),
  'U04 нет stop_reason': viaModel({ content: [text(sj(false))] }),
  'U04 stop_sequence': viaModel({ stop_reason: 'stop_sequence', content: [text(sj(false))] }),
  'U05 {}': viaModel({ stop_reason: 'end_turn', content: [text('{}')] }),
  'U05 null': viaModel({ stop_reason: 'end_turn', content: [text('null')] }),
  'U05 массив': viaModel({ stop_reason: 'end_turn', content: [text('[]')] }),
  'U05 не-булев': viaModel({ stop_reason: 'end_turn', content: [text('{"safety_flag":"false"}')] }),
  'U05 content не массив': viaModel({ stop_reason: 'end_turn', content: 'x' }),
  'U05 два text': viaModel({ stop_reason: 'end_turn', content: [text(sj(false)), text(sj(false))] }),
  'U05 не-булев от подставы': () => 'false',
};

for (const [name, check] of Object.entries(U)) {
  test(`${name}: 503/unavailable, render 0, нет safety и помощи`, async () => {
    await withApp({ check }, async ({ render, counters }) => {
      const r = await render();
      assert.ok(isUnavailable(r), JSON.stringify(r));
      assert.equal(counters.render, 0);
    });
  });
}

test('U06: нет ключа → 503/no_key, проверка не вызывается, render 0, счётчик не растёт', async () => {
  await withApp({ check: () => false, hasKey: () => false }, async ({ render, counters }) => {
    for (let i = 0; i < 3; i++) { const r = await render(); assert.ok(isUnavailable(r)); assert.equal(r.body.code, 'no_key'); }
    assert.equal(counters.check, 0); assert.equal(counters.render, 0);
  });
});

test('U07: неполный, затем end_turn+false → 200, один render', async () => {
  await withApp({ check: (t, n) => { if (n === 1) throw Object.assign(new Error('x'), { code: 'timeout' }); return false; } }, async ({ render, counters }) => {
    assert.ok(isUnavailable(await render()));
    const ok = await render();
    assert.equal(ok.status, 200); assert.match(ok.body.video, /^\/out\/.+\.mp4$/);
    assert.equal(counters.render, 1);
  });
  // Отрицательный контроль: сломанный рендер не выдаётся за успех проверки.
  await withApp({ check: () => false, render: async () => { throw Object.assign(new Error('x'), { code: 'ffmpeg' }); } }, async ({ render, counters }) => {
    const r = await render();
    assert.equal(r.status, 500); assert.equal(counters.render, 1);
  });
});

test('U08: safety установлен, затем любой U-сбой → safety сохраняется', async () => {
  let mode = 'true';
  await withApp({ check: () => { if (mode === 'true') return true; throw Object.assign(new Error('x'), { code: 'timeout' }); } }, async ({ render, counters }) => {
    assert.ok(isSafety(await render()));
    mode = 'fail';
    for (let i = 0; i < 3; i++) assert.ok(isSafety(await render()));
    assert.equal(counters.check, 1, 'после safety проверка не повторяется'); assert.equal(counters.render, 0);
  });
});

// ── 3. второй сбой и ручной повтор ──────────────────────────────────────────

const fail = () => { throw Object.assign(new Error('x'), { code: 'incomplete_response' }); };

test('T01: два неполных подряд одной версии → 503, затем 422/technical; render 0; без помощи; черновик тоже приостановлен', async () => {
  await withApp({ check: fail }, async ({ render, draft, counters, clock }) => {
    assert.ok(isUnavailable(await render()));
    const t = await render();
    assert.ok(isTechnical(t), JSON.stringify(t.body));
    assert.equal(t.body.code, 'check_incomplete_twice');
    assert.equal(t.body.retryNotBeforeAt, new Date(clock.wall + RETRY_AFTER_MS).toISOString(), 'UTC-момент = второй отказ + 15 мин');
    assert.ok(isTechnical(await render()), 'новая попытка рендера не запускает проверку');
    assert.ok(isTechnical(await draft()));
    assert.equal(counters.check, 2); assert.equal(counters.render, 0);
  });
});

test('T01: «подряд» — для одной версии: A-сбой, B-сбой, A-сбой не дают паузы', async () => {
  await withApp({ check: fail }, async ({ render, counters }) => {
    const other = ep(); other.title = 'Другая версия';
    assert.ok(isUnavailable(await render()));
    assert.ok(isUnavailable(await render(STORY, other)));
    assert.ok(isUnavailable(await render()));
    assert.ok(isTechnical(await render()), 'а два подряд одной версии — пауза');
    assert.equal(counters.render, 0);
  });
});

test('T01: сбои разных версий не складываются; успех сбрасывает счётчик версии', async () => {
  let n = 0;
  await withApp({ check: () => { n++; if (n === 2) return false; throw Object.assign(new Error('x'), { code: 'timeout' }); } }, async ({ render, counters }) => {
    const other = ep(); other.title = 'Другая версия';
    assert.ok(isUnavailable(await render()));           // 1: сбой версии A
    assert.equal((await render(STORY, ep())).status, 200); // 2: успех A — счётчик A сброшен
    assert.ok(isUnavailable(await render()));           // 3: сбой A — снова первый
    assert.ok(isUnavailable(await render(STORY, other))); // 4: сбой B — первый для B
    assert.equal(counters.render, 1);
  });
});

test('T02: ручной повтор в 899 999 мс — отказ без проверки; в 900 000 мс — полная проверка; само время ничего не снимает', async () => {
  let mode = 'fail';
  await withApp({ check: () => { if (mode === 'fail') fail(); return false; } }, async ({ render, recheck, clock, counters }) => {
    await render(); await render(); // technical
    const checks = counters.check;
    clock.mono += RETRY_AFTER_MS - 1; clock.wall += RETRY_AFTER_MS - 1;
    const early = await recheck();
    assert.ok(isTechnical(early)); assert.equal(early.body.early, true);
    assert.equal(counters.check, checks, 'ранний повтор не запускает проверку');
    clock.mono += 1; clock.wall += 1;
    assert.ok(isTechnical(await render()), 'истечение срока без действия организатора ничего не снимает');
    mode = 'ok';
    const ok = await recheck();
    assert.equal(ok.status, 200); assert.equal(ok.body.rechecked, true);
    assert.equal(counters.check, checks + 1);
    assert.equal((await render()).status, 200, 'после снятия — обычная полная проверка и рендер');
    assert.equal(counters.render, 1);
  });
});

test('T02: перевод системных часов вперёд не даёт раннего повтора (шкала — монотонная)', async () => {
  await withApp({ check: fail }, async ({ render, recheck, clock, counters }) => {
    await render(); await render();
    clock.wall += 24 * 3600 * 1000; // системные часы ушли на сутки вперёд
    const r = await recheck();
    assert.ok(isTechnical(r)); assert.equal(r.body.early, true);
    assert.equal(counters.check, 2);
  });
});

test('T03: через 900 с без действия организатора выдачи нет; старые play/render не снимают паузу', async () => {
  await withApp({ check: fail }, async ({ render, clock, counters }) => {
    await render(); await render();
    clock.mono += RETRY_AFTER_MS * 4;
    for (let i = 0; i < 3; i++) assert.ok(isTechnical(await render()));
    assert.equal(counters.check, 2); assert.equal(counters.render, 0);
  });
});

test('T04: допустимый ручной повтор: false → разрешение; true → safety; неполный → снова technical (новый срок)', async () => {
  for (const [outcome, expect] of [['false', 'ok'], ['true', 'safety'], ['fail', 'technical']]) {
    let mode = 'fail';
    await withApp({ check: () => { if (mode === 'fail') fail(); return mode === 'true'; } }, async ({ render, recheck, clock, counters }) => {
      await render(); await render();
      clock.mono += RETRY_AFTER_MS; clock.wall += RETRY_AFTER_MS;
      mode = outcome;
      const r = await recheck();
      if (expect === 'ok') { assert.equal(r.status, 200); assert.equal((await render()).status, 200); assert.equal(counters.render, 1); }
      if (expect === 'safety') { assert.ok(isSafety(r)); assert.ok(isSafety(await render())); assert.ok(isSafety(await recheck()), 'safety ручным повтором не снимается'); assert.equal(counters.render, 0); }
      if (expect === 'technical') {
        assert.ok(isTechnical(r));
        assert.equal(r.body.retryNotBeforeAt, new Date(clock.wall + RETRY_AFTER_MS).toISOString(), 'новый срок от нового отказа');
        const again = await recheck(); assert.equal(again.body.early, true);
        assert.equal(counters.render, 0);
      }
    });
  }
});

test('T05: два одновременных ручных повтора → одна проверка; поздний ответ прежней попытки не снимает новую паузу', async () => {
  let release; const gateP = new Promise((r) => { release = r; });
  let mode = 'fail';
  await withApp({ check: async () => { if (mode === 'fail') fail(); await gateP; return false; } }, async ({ render, recheck, clock, counters }) => {
    await render(); await render();
    clock.mono += RETRY_AFTER_MS; clock.wall += RETRY_AFTER_MS;
    mode = 'slow';
    const first = recheck();
    await new Promise((r) => setTimeout(r, 30));
    const second = await recheck();
    assert.equal(second.status, 409, 'второй повтор не запускает проверку');
    release();
    assert.equal((await first).status, 200);
    assert.equal(counters.check, 3, 'две неполных + одна полная');
  });
  // Поздний сбой прежней попытки (запрос A начат до паузы) не ставит новую паузу поверх ручного повтора,
  // и полный false повтора даёт разрешение (находка независимого разбора 10.11).
  let releaseA, releaseR;
  const heldA = new Promise((r) => { releaseA = r; });
  const heldR = new Promise((r) => { releaseR = r; });
  let call = 0;
  await withApp({ check: async () => {
    call++;
    if (call === 1) { await heldA; fail(); }   // A: висит, потом сбой
    if (call === 2 || call === 3) fail();      // B, C: неполные → technical
    if (call === 4) { await heldR; return false; } // ручной повтор: полный false
    return false;
  } }, async ({ render, recheck, clock, counters }) => {
    const a = render();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(isUnavailable(await render()));
    assert.ok(isTechnical(await render()));
    clock.mono += RETRY_AFTER_MS; clock.wall += RETRY_AFTER_MS;
    const r = recheck();
    await new Promise((res) => setTimeout(res, 30));
    releaseA();
    assert.ok(isUnavailable(await a), 'поздний сбой A — только 503 для своего запроса');
    releaseR();
    const done = await r;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await render()).status, 200);
    assert.equal(counters.render, 1);
  });
});

test('T06: safety во время ручного повтора сильнее позднего false; до очереди, в очереди и после рендера', async () => {
  // Во время повтора: параллельный запрос получает true.
  let hold; const held = new Promise((r) => { hold = r; });
  let call = 0;
  await withApp({ check: async (t) => { call++; if (call <= 2) fail(); if (call === 3) { await held; return false; } return true; } }, async ({ render, recheck, clock, post, counters }) => {
    await render(); await render();
    clock.mono += RETRY_AFTER_MS; clock.wall += RETRY_AFTER_MS;
    const pending = recheck();
    await new Promise((r) => setTimeout(r, 30));
    // Локальный слой по тому же рассказу (правка эпизода с опасной строкой) ставит safety.
    const bad = ep(); bad.post = { text: 'не хочу больше жить', source: 'не хочу больше жить' };
    assert.ok(isSafety(await post('/api/render', { story: STORY, episode: bad })));
    hold();
    assert.ok(isSafety(await pending), 'поздний false не снимает safety');
    assert.ok(isSafety(await render()));
    assert.equal(counters.render, 0);
  });
  // В очереди и после рендера: safety, пришедший пока ждали, — файл не отдаётся.
  let releaseRender; const slowRender = new Promise((r) => { releaseRender = r; });
  let c = 0;
  await withApp({ check: async () => { c++; return c >= 3; }, render: async (e, o) => { await slowRender; return { seconds: 1, outPath: o.outPath }; } }, async ({ render, counters }) => {
    const first = render();   // проверка 1 false → рендер висит
    await new Promise((r) => setTimeout(r, 30));
    const queued = render();  // проверка 2 false → ждёт в очереди
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(isSafety(await render())); // проверка 3 true → safety
    releaseRender();
    assert.ok(isSafety(await first), 'после рендера файл не отдаётся');
    assert.ok(isSafety(await queued), 'из очереди рендер не запускается');
    assert.equal(counters.render, 1);
  });
});

// ── 4. версия и состояние ───────────────────────────────────────────────────

test('V01: правка строки после разрешения → новая полная проверка; старое разрешение не используется', async () => {
  const seen = [];
  await withApp({ check: (t) => { seen.push(t); return seen.length >= 2; } }, async ({ render, counters }) => {
    assert.equal((await render()).status, 200);
    const edited = ep(); edited.rows[0].value = edited.rows[0].value + ' еще';
    assert.ok(isSafety(await render(STORY, edited)), 'новая версия проверена и остановлена');
    assert.notEqual(seen[0], seen[1]);
    assert.equal(counters.render, 1);
  });
});

test('V02: смена плёнки/музыки не снимает safety', async () => {
  await withApp({ check: () => true }, async ({ render, counters }) => {
    assert.ok(isSafety(await render()));
    for (const mood of ['warm', 'sad', 'anger', 'quiet']) { const e = ep(); e.mood = mood; e.music = mood; assert.ok(isSafety(await render(STORY, e))); }
    assert.equal(counters.check, 1); assert.equal(counters.render, 0);
  });
});

test('V03: регистр, ё/е и пробелы в остановленном рассказе — запрет сохраняется (действующая нормализация)', async () => {
  await withApp({ check: () => true }, async ({ render, counters }) => {
    assert.ok(isSafety(await render()));
    const variants = [STORY.toUpperCase(), `  ${STORY.replace(/\s+/g, '   ')}  `, STORY.replace(/е/g, 'ё')];
    for (const v of variants) assert.ok(isSafety(await render(v)), 'вариант остановлен');
    assert.equal(counters.check, 1); assert.equal(counters.render, 0);
  });
});

// ── 5. журнал ───────────────────────────────────────────────────────────────

test('L03: в ответ и журнал — только допустимый код; check_incomplete_twice — известный код', async () => {
  const lines = [];
  const orig = console.error; console.error = (l) => lines.push(String(l));
  try {
    await withApp({ check: coded('МАРКЕР-L03-код') }, async ({ render }) => {
      const r = await render();
      assert.ok(isUnavailable(r)); assert.equal(r.body.code, 'error');
      const t = await render();
      assert.ok(isTechnical(t)); assert.equal(t.body.code, 'check_incomplete_twice');
      const logged = lines.map((l) => JSON.parse(l));
      assert.deepEqual(logged.map((l) => [l.stage, l.code]), [['check', 'error'], ['check', 'check_incomplete_twice']], 'журнал пишет этап и код');
      for (const l of logged) assert.deepEqual(Object.keys(l).sort(), ['at', 'code', 'level', 'stage', 'version']);
      const all = JSON.stringify([r.body, t.body]) + lines.join('\n');
      assert.ok(!all.includes('МАРКЕР'), 'маркер исключения не выходит наружу');
      assert.ok(!all.includes(STORY.slice(0, 20)), 'текст рассказа не выходит наружу');
    });
  } finally { console.error = orig; }
  const { safeCode } = await import('../server/errlog.js');
  assert.equal(safeCode({ code: 'check_incomplete_twice' }), 'check_incomplete_twice');
  assert.equal(safeCode({ code: 'no_key' }), 'no_key');
});
