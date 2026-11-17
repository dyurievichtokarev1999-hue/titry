// Регрессия по повторному КОД-РЕВЬЮ QA GPT от 7.11.2026: гонки R1 (монтажная) и R2 (бот).
// Инвариант: после остановки по безопасности ни один запрос того же рассказа не запускает рендер и не отдаёт ролик;
// устаревший ответ «можно» не снимает остановку, удалённая сессия не оживает. Все рассказы вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createBot } from '../server/bot.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const ep = () => structuredClone(ex.episode);
const good = () => ({ episode: ep(), risk: { level: 'none' }, provider: 'claude', dropped: [] });
const blockedDraft = () => ({ episode: null, risk: { level: 'urgent', byModel: true, matches: [] }, provider: 'claude' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const metrics = { hash: () => 'qa-fictional', log: async () => {}, forget: async () => {} };
const chat = { id: 93210, type: 'private' };
const message = (text = ex.story) => ({ message: { chat, text } });
const click = (data) => ({ callback_query: { id: 'qa', data, message: { chat } } });

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    send: async (c, text, extra) => { sent.push({ text, extra }); },
    action: async () => {}, answer: async () => {},
    fileBuffer: async () => Buffer.from(''),
    sendVideo: async () => { sent.push({ text: 'VIDEO' }); },
  };
}
const keyboards = (tg) => tg.sent.filter((x) => x.extra && x.extra.reply_markup && x.extra.reply_markup.inline_keyboard);
// Нажать «Смотреть» со всеми номерами, которые могли быть у черновиков: ни один не должен сработать.
async function pressEveryPlay(bot) {
  for (let n = 0; n <= 6; n++) await bot.handleUpdate(click(`play:${n}`));
  await bot.handleUpdate(click('play'));
}

async function withApp(safetyCheck, fn, render) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-race-'));
  const calls = [];
  const server = createApp({
    dataDir: dir, safetyCheck,
    render: render ? (e, o) => { calls.push(o); return render(e, o); } : async (e, o) => { calls.push(o); return { seconds: 1, outPath: o.outPath }; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const post = (url, body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try { await fn({ post, calls, dir }); }
  finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── R1: монтажная, /api/render ───────────────────────────────────────────────

test('R1 (воспроизведение QA): старое «можно» не перекрывает уже состоявшуюся остановку', async () => {
  const a = deferred(), b = deferred(), startedA = deferred(), startedB = deferred();
  let checks = 0;
  const safety = () => {
    checks++;
    if (checks === 1) { startedA.resolve(); return a.promise; }
    startedB.resolve(); return b.promise;
  };
  await withApp(safety, async ({ post, calls }) => {
    const body = { episode: ep(), story: ex.story };
    const older = post('/api/render', body); await startedA.promise;
    const newer = post('/api/render', body); await startedB.promise;
    b.resolve(true);
    const stop = await newer; assert.equal(stop.status, 422); await stop.text();
    a.resolve(false);
    const allow = await older; assert.equal(allow.status, 422, 'старый допуск тоже получает остановку'); await allow.text();
    assert.equal(calls.length, 0, 'рендер запрещён после остановки того же рассказа');
  });
});

test('R1: остановка пришла, пока задача ждала в очереди, — рендер не вызывается', async () => {
  const firstRender = deferred(), firstStarted = deferred(), flagSecond = deferred(), secondChecked = deferred();
  let checks = 0;
  const safety = async (text) => {
    checks++;
    if (checks <= 2) return false; // оба рассказа сначала проходят проверку
    secondChecked.resolve();
    return flagSecond.promise;
  };
  let renderN = 0;
  const render = async (e, o) => {
    renderN++;
    if (renderN === 1) { firstStarted.resolve(); await firstRender.promise; }
    return { seconds: 1, outPath: o.outPath };
  };
  await withApp(safety, async ({ post, calls }) => {
    const other = { ...ep(), title: 'Другой вечер' };
    const otherStory = `${ex.story} Вечером я долго гулял.`;
    const first = post('/api/render', { episode: other, story: otherStory }); // занимает очередь
    await firstStarted.promise;
    const queued = post('/api/render', { episode: ep(), story: ex.story }); // встаёт в очередь
    await new Promise((r) => setTimeout(r, 30));
    const third = post('/api/render', { episode: ep(), story: ex.story }); // параллельная проверка того же рассказа
    await secondChecked.promise;
    flagSecond.resolve(true);
    const stop = await third; assert.equal(stop.status, 422); await stop.text();
    firstRender.resolve();
    assert.equal((await first).status, 200);
    const q = await queued; assert.equal(q.status, 422, 'задача из очереди остановлена'); await q.text();
    assert.equal(calls.length, 1, 'вызван только рендер другого рассказа');
    assert.equal(calls[0].story, otherStory);
  }, render);
});

test('R1: остановка пришла во время рендера — файл удалён, ролик не отдан', async () => {
  const renderGo = deferred(), renderStarted = deferred(), secondCheck = deferred();
  let checks = 0;
  const safety = async () => {
    checks++;
    if (checks === 1) return false;
    return secondCheck.promise;
  };
  const render = async (e, o) => {
    renderStarted.resolve();
    await renderGo.promise;
    await fs.mkdir(path.dirname(o.outPath), { recursive: true });
    await fs.writeFile(o.outPath, 'fake-mp4');
    await fs.writeFile(o.posterPath, 'fake-jpg');
    return { seconds: 1, outPath: o.outPath };
  };
  await withApp(safety, async ({ post, calls, dir }) => {
    const body = { episode: ep(), story: ex.story };
    const rendering = post('/api/render', body);
    await renderStarted.promise;
    const second = post('/api/render', body);
    secondCheck.resolve(true);
    assert.equal((await second).status, 422);
    renderGo.resolve();
    const r = await rendering;
    assert.equal(r.status, 422, 'готовый ролик не отдаётся');
    const json = await r.json();
    assert.equal(json.video, undefined);
    assert.equal(calls.length, 1);
    const left = await fs.readdir(path.join(dir, 'out')).catch(() => []);
    assert.deepEqual(left.filter((f) => /\.(mp4|jpg)$/.test(f)), [], 'файлы удалены');
  }, render);
});

test('R1: черновик, пришедший после остановки того же рассказа, не отдаётся', async () => {
  await withApp(async () => true, async ({ post, calls }) => {
    const stop = await post('/api/render', { episode: ep(), story: ex.story });
    assert.equal(stop.status, 422); await stop.text();
    const d = await post('/api/draft', { story: ex.story, provider: 'manual' });
    const json = await d.json();
    assert.equal(json.episode, undefined, 'черновик запрещённого рассказа не выдаётся');
    assert.equal(json.risk.level, 'urgent');
    assert.equal(calls.length, 0);
  });
});

// ── R2: бот, поздний старый ответ ───────────────────────────────────────────

test('R2 (воспроизведение QA): поздний старый черновик не восстанавливает остановленный эпизод', async () => {
  const pending = deferred(), started = deferred();
  let drafts = 0, renders = 0;
  const tg = fakeTelegram();
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics,
    draft: async () => { drafts++; if (drafts === 1) { started.resolve(); return pending.promise; } return blockedDraft(); },
    render: async (e, o) => { renders++; return { outPath: o.outPath, seconds: 1, duration: 24 }; },
  });
  const old = bot.handleUpdate(message()); await started.promise;
  await bot.handleUpdate(message());
  assert.equal(bot.sessions.get(chat.id).stage, 'help');
  pending.resolve(good()); await old;
  // QA нажимал кнопку из позднего ответа. Правильный бот её не присылает, поэтому жмём все возможные номера.
  assert.equal(keyboards(tg).length, 0, 'поздний ответ не отправил черновик с кнопками');
  await pressEveryPlay(bot);
  const s = bot.sessions.get(chat.id);
  assert.equal(renders, 0, 'старый ответ модели не оживил остановленный черновик');
  assert.equal(s.stage, 'help');
  assert.equal(s.episode, null);
});

test('R2: поздняя остановка уничтожает уже показанный черновик того же рассказа', async () => {
  const pending = deferred(), started = deferred();
  let drafts = 0, renders = 0;
  const tg = fakeTelegram();
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics,
    draft: async () => { drafts++; if (drafts === 1) { started.resolve(); return pending.promise; } return good(); },
    render: async (e, o) => { renders++; return { outPath: o.outPath, seconds: 1, duration: 24 }; },
  });
  const old = bot.handleUpdate(message()); await started.promise;
  await bot.handleUpdate(message()); // второй запрос того же рассказа успел раньше: черновик показан
  assert.equal(bot.sessions.get(chat.id).stage, 'draft');
  pending.resolve(blockedDraft()); await old; // первый запрос вернул остановку позже
  await pressEveryPlay(bot);
  assert.equal(renders, 0);
  assert.equal(bot.sessions.get(chat.id).stage, 'help');
  assert.equal(bot.sessions.get(chat.id).episode, null);
});

test('R2: /delete во время незавершённого черновика — сессия не оживает, сообщений нет', async () => {
  const pending = deferred(), started = deferred();
  const tg = fakeTelegram();
  const logged = [];
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics: { ...metrics, log: async (c, ev) => { logged.push(ev); } },
    draft: async () => { started.resolve(); return pending.promise; },
  });
  const old = bot.handleUpdate(message()); await started.promise;
  await bot.handleUpdate(message('/delete'));
  const before = tg.sent.length;
  pending.resolve(good()); await old;
  assert.equal(bot.sessions.size, 0, 'удалённая сессия не появилась снова');
  assert.equal(tg.sent.length, before, 'после удаления бот ничего не отправил');
  assert.ok(!logged.includes('story') && !logged.includes('draft'), 'метрики удалённого пользователя не пишутся');
});

test('R2: остановка во время рендера в боте — видео не отправлено, файл удалён', async () => {
  const renderGo = deferred(), renderStarted = deferred(), lateBlock = deferred(), lateStarted = deferred();
  let drafts = 0;
  let outPath = null;
  const tg = fakeTelegram();
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics,
    draft: async () => {
      drafts++;
      if (drafts === 1) { lateStarted.resolve(); return lateBlock.promise; } // медленная проверка, ответит остановкой
      return good();
    },
    render: async (e, o) => {
      outPath = o.outPath;
      renderStarted.resolve();
      await renderGo.promise;
      await fs.mkdir(path.dirname(o.outPath), { recursive: true });
      await fs.writeFile(o.outPath, 'fake-mp4');
      return { outPath: o.outPath, seconds: 1, duration: 24 };
    },
  });
  const slow = bot.handleUpdate(message()); await lateStarted.promise;
  await bot.handleUpdate(message()); // быстрый ответ: черновик показан
  const play = keyboards(tg).at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  const rendering = bot.handleUpdate(click(play));
  await renderStarted.promise;
  lateBlock.resolve(blockedDraft()); await slow; // остановка пришла, пока идёт рендер
  renderGo.resolve(); await rendering;
  assert.ok(!tg.sent.some((x) => x.text === 'VIDEO'), 'видео не отправлено');
  await assert.rejects(fs.stat(outPath), 'временный файл удалён');
  assert.equal(bot.sessions.get(chat.id).stage, 'help');
});

test('R2: /delete во время рендера — видео не отправлено', async () => {
  const renderGo = deferred(), renderStarted = deferred();
  const tg = fakeTelegram();
  const bot = createBot({ safetyCheck: async () => false,
    tg, metrics,
    draft: async () => good(),
    render: async (e, o) => { renderStarted.resolve(); await renderGo.promise; return { outPath: o.outPath, seconds: 1, duration: 24 }; },
  });
  await bot.handleUpdate(message());
  const play = keyboards(tg).at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  const rendering = bot.handleUpdate(click(play));
  await renderStarted.promise;
  await bot.handleUpdate(message('/delete'));
  renderGo.resolve(); await rendering;
  assert.ok(!tg.sent.some((x) => x.text === 'VIDEO'));
  assert.equal(bot.sessions.size, 0);
});

test('R2: обычный путь не сломан — черновик, кнопка, видео', async () => {
  let renders = 0;
  const tg = fakeTelegram();
  const bot = createBot({ safetyCheck: async () => false, tg, metrics, draft: async () => good(), render: async (e, o) => { renders++; return { outPath: o.outPath, seconds: 1, duration: 24 }; } });
  await bot.handleUpdate(message());
  const play = keyboards(tg).at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  await bot.handleUpdate(click(play));
  assert.equal(renders, 1);
  assert.ok(tg.sent.some((x) => x.text === 'VIDEO'));
  assert.equal(bot.sessions.get(chat.id).stage, 'watched');
});

// ── R3 (ревью QA 9.11.2026): окно между проверкой и стартом рендера, пока ждём tg.action ─────────

for (const mode of ['поздняя остановка', '/delete']) {
  test(`R3: ${mode} во время tg.action('upload_video') — рендер не начинается`, async () => {
    const actionEntered = deferred(), actionGo = deferred(), firstDraft = deferred(), firstStarted = deferred();
    let drafts = 0, renders = 0;
    const tg = fakeTelegram();
    tg.action = async (c, a) => { if (a === 'upload_video') { actionEntered.resolve(); await actionGo.promise; } };
    const bot = createBot({ safetyCheck: async () => false,
      tg, metrics,
      draft: async () => {
        if (mode === 'поздняя остановка' && ++drafts === 1) { firstStarted.resolve(); return firstDraft.promise; }
        return good();
      },
      render: async (e, o) => { renders++; return { outPath: o.outPath, seconds: 1, duration: 24 }; },
    });
    let old;
    if (mode === 'поздняя остановка') { old = bot.handleUpdate(message()); await firstStarted.promise; }
    await bot.handleUpdate(message());
    const play = keyboards(tg).at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
    const playing = bot.handleUpdate(click(play));
    await actionEntered.promise;
    if (mode === 'поздняя остановка') {
      firstDraft.resolve(blockedDraft()); await old;
      assert.equal(bot.sessions.get(chat.id).stage, 'help');
    } else {
      await bot.handleUpdate(message('/delete'));
      assert.equal(bot.sessions.size, 0);
    }
    actionGo.resolve(); await playing;
    assert.equal(renders, 0, 'рендер не должен стартовать после остановки или удаления');
    assert.ok(!tg.sent.some((x) => x.text === 'VIDEO'));
  });
}

test('R3: /delete во время sendVideo — после forget запись render не появляется', async () => {
  const sendEntered = deferred(), sendGo = deferred();
  const events = [];
  const m = { hash: () => 'qa-fictional', log: async (c, ev) => { events.push(ev); }, forget: async () => { events.push('forget'); } };
  const tg = fakeTelegram();
  tg.sendVideo = async () => { sendEntered.resolve(); await sendGo.promise; tg.sent.push({ text: 'VIDEO' }); };
  const bot = createBot({ safetyCheck: async () => false, tg, metrics: m, draft: async () => good(), render: async (e, o) => ({ outPath: o.outPath, seconds: 1, duration: 24 }) });
  await bot.handleUpdate(message());
  const play = keyboards(tg).at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data;
  const playing = bot.handleUpdate(click(play));
  await sendEntered.promise;
  await bot.handleUpdate(message('/delete'));
  sendGo.resolve(); await playing;
  assert.ok(!events.slice(events.indexOf('forget')).includes('render'));
  assert.equal(bot.sessions.size, 0);
});
