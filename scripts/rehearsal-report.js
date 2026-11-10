#!/usr/bin/env node
// Отчёт «Репетиции» R16–R20 и H/S (ИР-05). Прогоняет вымышленные случаи редактора через настоящий путь
// черновика (makeDraft) с подставной моделью, которая возвращает «правильный» или «неверный» ответ.
// Печатает только ID и статусы — без текстов рассказов. Модель не вызывается, сети нет.
import fs from 'node:fs/promises';
import { makeDraft } from '../server/draft.js';
import { assessRisk } from '../server/safety.js';

const data = JSON.parse(await fs.readFile(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));
const fakeModel = (raw) => ({ beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(raw) }] }) } } });

export async function runCase(c, variant) {
  const r = await makeDraft(c.story, { provider: 'claude', client: fakeModel(c[variant]), date: '2026-11-10' });
  if (r.unavailable) return { status: 'unavailable' };
  if (!r.episode) return { status: 'stopped', byModel: !!r.risk?.byModel };
  return { status: 'draft', valid: r.validation.ok, rows: r.episode.rows.map((x) => x.value) };
}

export async function report() {
  const out = { cases: [], localFilter: {} };
  for (const c of data.cases) {
    out.cases.push({ id: c.id, expect: c.expect, local: assessRisk(c.story).level, good: await runCase(c, 'good'), bad: await runCase(c, 'bad') });
  }
  const lv = (t) => assessRisk(t).level;
  out.localFilter.stop = data.stop.map((s) => ({ id: s.id, level: lv(s.text) }));
  out.localFilter.hyperbole = data.hyperbole.map((h) => ({ id: h.id, level: lv(h.text) }));
  out.localFilter.combos = [];
  for (const h of ['H01', 'H02', 'H04']) for (const s of ['S01', 'S02', 'S04']) {
    const t = `${data.hyperbole.find((x) => x.id === h).text} ${data.stop.find((x) => x.id === s).text}`;
    out.localFilter.combos.push({ id: `${h}+${s}`, level: lv(t) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await report();
  for (const c of r.cases) {
    const verdict = c.expect === 'stop'
      ? (c.bad.status === 'stopped' ? 'остановлено системой' : 'НЕ остановлено при неверном ответе модели')
      : (c.bad.status === 'draft' ? 'система пропустила — нужен отказ организатора' : `система: ${c.bad.status}`);
    console.log(`${c.id}: эталон=${c.good.status}${c.good.valid === false ? ' (не прошёл проверку)' : ''}; неверный=${c.bad.status}; локальный фильтр=${c.local} → ${verdict}`);
  }
  const fmt = (xs) => xs.map((x) => `${x.id}=${x.level}`).join(' ');
  const stopped = (xs) => xs.filter((x) => x.level === 'urgent').length;
  console.log(`S (локальный фильтр): ${stopped(r.localFilter.stop)}/${r.localFilter.stop.length} urgent — ${fmt(r.localFilter.stop)}`);
  console.log(`H+S (локальный фильтр): ${stopped(r.localFilter.combos)}/${r.localFilter.combos.length} urgent — ${fmt(r.localFilter.combos)}`);
  console.log(`H (локальный фильтр, ложные остановки): ${stopped(r.localFilter.hyperbole)}/${r.localFilter.hyperbole.length}`);
}
