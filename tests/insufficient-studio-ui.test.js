// Экран монтажной при нехватке материала после исключения (решение владельца по PR 11): studio/studio.js
// выполняется в Node vm на подставном DOM (в духе vm-тестов интерфейса репетиции). Сервер подменён ответами fetch.
// Только вымышленные тексты: examples/day-quiet.json и вымышленные рассказы «B».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as episode from '../engine/episode.js';
import { timeline, DEFAULT_DURATION } from '../engine/draw.js';
import { helpMessage } from '../server/safety.js';

const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const REPLY = 'Не получилось собрать титры только из твоих слов. Сегодня можно без ролика.';
const HELP = helpMessage('concern'); // тот же блок, что отдаёт сервер
const SRC = (await fs.readFile(new URL('../studio/studio.js', import.meta.url), 'utf8')).replace(/^import .*$/gm, '');

class El {
  constructor(id = '', tag = 'div') {
    Object.assign(this, { id, tag, value: '', hidden: false, disabled: false, checked: false, innerHTML: '', className: '', type: '', title: '', placeholder: '' });
    this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.paused = true; this._text = '';
    this.classList = { add() {}, remove() {} }; this.style = {};
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (v === '') this.children = []; }
  get src() { return this.attrs.src || ''; }
  set src(v) { this.attrs.src = String(v); }
  get href() { return this.attrs.href || ''; }
  set href(v) { this.attrs.href = String(v); }
  get download() { return this.attrs.download || ''; }
  set download(v) { this.attrs.download = String(v); }
  append(...c) { this.children.push(...c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { this.listeners[t] = f; }
  querySelector(sel) { const m = /data-k=(\w+)/.exec(sel); return m ? this.children.find((c) => c.dataset.k === m[1]) || null : null; }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  focus() {}
  getContext() { return {}; }
}

function studio(routes) {
  const els = {};
  const el = (id) => (els[id] ||= new El(id));
  for (const id of ['result', 'recheckBtn', 'help']) el(id).hidden = true; // как в index.html
  el('date').value = '2026-11-11'; el('period').value = 'day'; el('music').value = 'quiet';
  const calls = [];
  const fetch = async (p, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push(p);
    const r = await routes(p, body);
    const status = r?.status || 200;
    return { ok: status < 400, status, json: async () => (r?.status ? r.body : r) };
  };
  const ctx = {
    ...episode, timeline, DEFAULT_DURATION, drawFrame: () => {},
    document: { getElementById: el, createElement: (tag) => new El('', tag), querySelectorAll: () => [] },
    Audio: function Audio() { return new El('audio', 'audio'); },
    fetch, structuredClone, performance, requestAnimationFrame: () => 0, console,
  };
  vm.runInNewContext(SRC, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  const click = async (id) => { await el(id).listeners.click?.(); await tick(); };
  const draft = async (story) => { el('story').value = story; await click('draftBtn'); };
  return { el, calls, click, draft, tick };
}

const okDraft = () => ({ episode: structuredClone(ex.episode), validation: { ok: true }, risk: { level: 'none' }, provider: 'claude', dropped: [] });
const insufficient = (help) => ({ status: 422, body: help ? { kind: 'insufficient', error: REPLY, help } : { kind: 'insufficient', error: REPLY } });
const B = 'Вымышленный рассказ B: я злюсь на соседа и хочу его ударить.';

function assertCleared(u) {
  const video = u.el('video');
  assert.equal(video.paused, true, 'ролик A не играет');
  assert.equal(video.getAttribute('src'), null, 'у плеера нет файла A');
  assert.equal(u.el('download').getAttribute('href'), null, 'нет ссылки скачивания A');
  assert.equal(u.el('result').hidden, true, 'блок результата скрыт');
  assert.equal(u.el('recheckBtn').hidden, true, 'кнопки повтора нет');
  assert.equal(u.el('renderBtn').disabled, true, 'рендер выключен');
  assert.equal(u.el('draftNote').textContent, REPLY, 'реплика дословно');
  assert.equal(u.el('renderNote').textContent, '');
  assert.equal(u.el('rows').children.length, 0, 'черновика нет');
}

test('монтажная: ролик A, затем нехватка B → нет проигрываемого A, ссылки A и повтора; рендер не запускается', async () => {
  let render = 0;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return u.calls.filter((x) => x === '/api/draft').length === 1 ? okDraft() : insufficient();
    if (p === '/api/render') { render++; return { video: '/out/a.mp4', seconds: 3 }; }
    if (p === '/api/out/delete') throw new Error('файлы не трогаются');
    return {};
  });
  await u.draft(ex.story);
  assert.equal(u.el('renderBtn').disabled, false);
  await u.click('renderBtn');
  assert.equal(u.el('result').hidden, false); assert.equal(u.el('video').getAttribute('src'), '/out/a.mp4');
  await u.el('video').play();
  await u.draft(B);
  assertCleared(u);
  assert.equal(u.el('help').hidden, true, 'без concern — только реплика');
  await u.click('renderBtn'); await u.click('recheckBtn');
  assert.equal(render, 1, 'после нехватки рендер не вызывается');
  assert.ok(!u.calls.includes('/api/recheck'));
  assert.ok(!u.calls.includes('/api/out/delete'), 'удаление файлов — только действующим маршрутом');
});

test('монтажная: открытая техническая пауза, затем нехватка с concern → кнопка перепроверки скрыта, блок помощи за репликой', async () => {
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return u.calls.filter((x) => x === '/api/draft').length === 1 ? okDraft() : insufficient(HELP);
    if (p === '/api/render') return { status: 422, body: { kind: 'technical', reason: 'check_incomplete_twice', error: 'Проверка приостановлена', message: 'm', next: 'n' } };
    return {};
  });
  await u.draft(ex.story);
  await u.click('renderBtn');
  assert.equal(u.el('recheckBtn').hidden, false, 'пауза открыта');
  await u.draft(B);
  assertCleared(u);
  assert.equal(u.el('help').hidden, false, 'блок помощи показан');
  assert.equal(u.el('helpText').textContent, `${REPLY}\n\n${HELP}`, 'сначала реплика, сразу за ней тот же блок помощи, без переходной фразы');
  await u.click('recheckBtn');
  assert.ok(!u.calls.includes('/api/recheck'));
});

test('монтажная: рендер A, завершившийся уже после нехватки B, ролик не показывает', async () => {
  let finish;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return u.calls.filter((x) => x === '/api/draft').length === 1 ? okDraft() : insufficient();
    if (p === '/api/render') return new Promise((r) => { finish = () => r({ video: '/out/a.mp4', seconds: 3 }); });
    return {};
  });
  await u.draft(ex.story);
  const rendering = u.el('renderBtn').listeners.click();
  await u.tick();
  await u.draft(B);
  finish(); await rendering; await u.tick();
  assertCleared(u);
});

test('монтажная: после нехватки новый проверенный черновик возвращает обычный маршрут', async () => {
  let render = 0;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return u.calls.filter((x) => x === '/api/draft').length === 1 ? insufficient() : okDraft();
    if (p === '/api/render') { render++; return { video: '/out/c.mp4', seconds: 3 }; }
    return {};
  });
  await u.draft(B);
  assert.equal(u.el('renderBtn').disabled, true);
  await u.draft(ex.story);
  assert.equal(u.el('renderBtn').disabled, false);
  await u.click('renderBtn');
  assert.equal(render, 1);
  assert.equal(u.el('result').hidden, false);
  assert.equal(u.el('video').getAttribute('src'), '/out/c.mp4');
  assert.equal(u.el('download').getAttribute('href'), '/out/c.mp4');
});

test('id элементов из studio.js есть в index.html (подставной DOM не скрывает опечатки)', async () => {
  const html = await fs.readFile(new URL('../studio/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...new Set([...SRC.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((id) => !ids.has(id)), []);
});

test('монтажная: нехватка, затем технический ответ для нового рассказа → кнопка перепроверки видна и работает', async () => {
  let n = 0;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return ++n === 1 ? insufficient() : { status: 422, body: { kind: 'technical', reason: 'check_incomplete_twice', error: 'Проверка приостановлена', message: 'm', next: 'n' } };
    if (p === '/api/recheck') return { rechecked: true };
    return {};
  });
  await u.draft(B);
  await u.draft('Вымышленный рассказ C: утром я пила чай. Вечером я читала книгу.');
  assert.equal(u.el('recheckBtn').hidden, false);
  await u.click('recheckBtn');
  assert.ok(u.calls.includes('/api/recheck'), 'кнопка не мёртвая');
});

test('монтажная: перепроверка, завершившаяся после нехватки, не меняет экран', async () => {
  let finish; let n = 0;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return ++n === 1 ? okDraft() : insufficient();
    if (p === '/api/render') return { status: 422, body: { kind: 'technical', reason: 'check_incomplete_twice', error: 'e', message: 'm', next: 'n' } };
    if (p === '/api/recheck') return new Promise((r) => { finish = () => r({ rechecked: true }); });
    return {};
  });
  await u.draft(ex.story);
  await u.click('renderBtn');
  const rechecking = u.el('recheckBtn').listeners.click();
  await u.tick();
  await u.draft(B);
  finish(); await rechecking; await u.tick();
  assertCleared(u);
});

test('монтажная: открытая помощь прежнего черновика закрывается при нехватке без concern; журнал без прежнего provider', async () => {
  let n = 0; let logged;
  const u = studio(async (p, body) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return ++n === 1 ? { ...okDraft(), risk: { level: 'concern' }, help: HELP } : insufficient();
    if (p === '/api/log') { logged = body; return { saved: 'x' }; }
    return {};
  });
  await u.draft(ex.story);
  assert.equal(u.el('help').hidden, false);
  await u.draft(B);
  assert.equal(u.el('help').hidden, true, 'на экране одна реплика');
  assertCleared(u);
  await u.click('logBtn');
  assert.equal(logged.provider, null);
});

test('монтажная: поздний ответ «нехватка» не очищает форму с уже выбранным примером; кнопка черновика работает', async () => {
  let finish;
  const u = studio(async (p) => {
    if (p === '/api/config') return { provider: 'claude', model: 'm' };
    if (p === '/api/draft') return new Promise((r) => { finish = () => r(insufficient()); });
    if (p.startsWith('/examples/')) return { story: ex.story, episode: ex.episode };
    return {};
  });
  u.el('story').value = B;
  const drafting = u.el('draftBtn').listeners.click();
  await u.tick();
  u.el('example').value = 'day-quiet';
  await u.el('example').listeners.change(); await u.tick();
  assert.equal(u.el('draftBtn').disabled, false, 'после выбора примера можно снова запросить черновик');
  finish(); await drafting; await u.tick();
  assert.equal(u.el('title').value, ex.episode.title, 'пример остался в форме');
  assert.equal(u.el('rows').children.length, ex.episode.rows.length);
  assert.notEqual(u.el('draftNote').textContent, REPLY);
  assert.equal(u.el('renderBtn').disabled, false, 'рендер примера доступен');
  assert.equal(u.el('draftBtn').disabled, false);
});
