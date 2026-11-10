#!/usr/bin/env node
// L01: отчёт в три колонки по S/H/R20 — локальный фильтр, отдельная проверка, генератор — и маршрутный исход.
// Реальная модель не вызывается (вымышленный стенд, ключей нет): колонки модельных слоёв — not-run.
// Маршрутный исход — монтажная с «разрешающими» подставными модельными слоями (худший случай для локального слоя).
// Печатает только ID и статусы, без текстов.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessRisk } from '../server/safety.js';
import { createApp } from '../server/app.js';

const data = JSON.parse(await fs.readFile(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));
const ex = JSON.parse(await fs.readFile(new URL('../examples/day-quiet.json', import.meta.url), 'utf8'));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'titry-layers-'));
let renders = 0;
const server = createApp({ dataDir, safetyCheck: async () => false, render: async (e, o) => { renders++; return { seconds: 1, outPath: o.outPath }; } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const route = async (text) => {
  const before = renders;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story: `${ex.story} ${text}`, episode: ex.episode }) });
  return `${res.status}, render ${renders - before}`;
};
const items = [
  ...data.stop.map((s) => ({ id: s.id, text: s.text, expect: 'stop' })),
  ...data.hyperbole.map((h) => ({ id: h.id, text: h.text, expect: 'pass' })),
  { id: 'R20', text: data.cases.find((c) => c.id === 'R20').story, expect: 'stop' },
];
console.log('ID | ожидание | локальный фильтр | отдельная проверка | генератор | маршрут (модельные слои «false»)');
for (const it of items) {
  console.log(`${it.id} | ${it.expect} | ${assessRisk(it.text).level} | not-run | not-run | ${await route(it.text)}`);
}
server.close();
await fs.rm(dataDir, { recursive: true, force: true });
