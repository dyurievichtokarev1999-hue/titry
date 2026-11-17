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
    checkRetryMs: 0,
    render: async (e, o) => { counters.render++; if (opts.render) return opts.render(e, o); return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const render = (story = STORY, episode = ep()) => post('/api/render', { story, episode });
  const draft = (story = STORY) => post('/api/draft', { story });
  try { await fn({ post, render, draft, clock, counters }); }
  finally { server.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

const isSafety = (r) => r.status === 422 && r.body.kind === 'safety' && typeof r.body.help === 'string' && r.body.help.length > 0;
const CONCERN_STORY = `${STORY} Хочу его ударить.`; // локальный concern (гнев на другого), вымышленный
const isTryLater = (r) => r.status === 503 && r.body.unknown === true && typeof r.body.help === 'string' && /112/.test(r.body.help) && r.body.kind !== 'safety';

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

test('S04: true с max_tokens → safety; неразборчивый max_tokens — «неизвестно»: чисто — рендер, concern — ролика нет', async () => {
  await withApp({ check: viaModel({ stop_reason: 'max_tokens', content: [text(sj(true))] }) }, async ({ render, counters }) => {
    assert.ok(isSafety(await render())); assert.equal(counters.render, 0);
  });
  await withApp({ check: viaModel({ stop_reason: 'max_tokens', content: [text('{"safety_fl')] }) }, async ({ render, counters }) => {
    assert.ok(isTryLater(await render(CONCERN_STORY)));
    assert.equal(counters.render, 0);
    assert.equal((await render()).status, 200);
    assert.equal(counters.render, 1);
  });
});

// ── 2. «неизвестно» (решение владельца кода 13.11 15:00, условие 3) ──────────────
// Один повтор; затем локально чисто — рендер, локальный concern — ролика нет (короткий текст и контакты).

const U = {
  'U01 сеть': coded('ECONNRESET'),
  'U01 timeout': coded('timeout'),
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
  test(`${name}: повтор, локально чисто → рендер; concern → 503 «не получилось» с контактами, без safety`, async () => {
    await withApp({ check }, async ({ render, counters }) => {
      const r = await render();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(counters.check, 2, 'один повтор'); assert.equal(counters.render, 1);
      const c = await render(CONCERN_STORY);
      assert.ok(isTryLater(c), JSON.stringify(c.body));
      assert.equal(counters.render, 1);
    });
  });
}

test('U06: нет ключа → только локальный фильтр: рендер, проверка не вызывается', async () => {
  await withApp({ check: () => false, hasKey: () => false }, async ({ render, counters }) => {
    for (let i = 0; i < 3; i++) assert.equal((await render()).status, 200);
    assert.equal(counters.check, 0); assert.equal(counters.render, 3);
  });
});

test('U07: неполный, повтор end_turn+false → 200, один render', async () => {
  await withApp({ check: (t, n) => { if (n === 1) throw Object.assign(new Error('x'), { code: 'timeout' }); return false; } }, async ({ render, counters }) => {
    const ok = await render();
    assert.equal(ok.status, 200); assert.match(ok.body.video, /^\/out\/.+\.mp4$/);
    assert.equal(counters.check, 2); assert.equal(counters.render, 1);
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

test('U02 refusal: отказ проверяющей модели — без повтора, как локальный concern: ролика нет, «не получилось» и контакты', async () => {
  await withApp({ check: viaModel({ stop_reason: 'refusal', content: [text(sj(false))] }) }, async ({ render, counters }) => {
    const r = await render();
    assert.ok(isTryLater(r), JSON.stringify(r.body));
    assert.ok(!r.body.help.includes(r.body.error), 'текст «не получилось» не повторяется в блоке контактов');
    assert.equal(counters.check, 1, 'без повтора'); assert.equal(counters.render, 0);
  });
});

// ── 3. остановка во время рендера ──────────────────────────────────────────
// T01–T05 и первая часть T06 (техническая пауза после двух неполных, ручной повтор организатора) удалены:
// паузы и повтора организатора больше нет (решение владельца кода 13.11 15:00).

test('T06: safety, пришедший в очереди и после рендера, — файл не отдаётся', async () => {
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
    // правка из слов той же цитаты (новое правило 11.11: чужое слово не прошло бы проверку строки)
    const edited = ep(); edited.rows[0].value = edited.rows[0].value.split(' ').slice(1).join(' ');
    assert.notEqual(edited.rows[0].value, ep().rows[0].value);
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

test('L03: в ответ и журнал — только допустимый код, без маркеров исключения и текста рассказа', async () => {
  const lines = [];
  const orig = console.error; console.error = (l) => lines.push(String(l));
  try {
    await withApp({ check: coded('МАРКЕР-L03-код') }, async ({ render }) => {
      const r = await render(CONCERN_STORY);
      assert.ok(isTryLater(r)); assert.equal(r.body.code, 'error');
      const logged = lines.map((l) => JSON.parse(l));
      assert.deepEqual(logged.map((l) => [l.stage, l.code]), [['check', 'error']], 'журнал пишет этап и код');
      for (const l of logged) assert.deepEqual(Object.keys(l).sort(), ['at', 'code', 'level', 'stage', 'version']);
      const all = JSON.stringify(r.body) + lines.join('\n');
      assert.ok(!all.includes('МАРКЕР'), 'маркер исключения не выходит наружу');
      assert.ok(!all.includes(STORY.slice(0, 20)), 'текст рассказа не выходит наружу');
    });
  } finally { console.error = orig; }
  const { safeCode } = await import('../server/errlog.js');
  assert.equal(safeCode({ code: 'no_key' }), 'no_key');
});
