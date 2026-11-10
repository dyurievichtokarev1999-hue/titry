// «Репетиция» R16–R20, часть 2 (ИР-05): режим монтажной для организатора.
// Организатор видит намеренно неверный черновик модели по вымышленному рассказу редактора и выбирает действие:
// принять, отклонить с указанием нарушенного инварианта или остановить (сигнал безопасности).
// Это упражнение: ролик в репетиции не собирается, ответы организатора не записываются никуда.
import fs from 'node:fs';
import { groundDraft } from './draft.js';

const DATA = JSON.parse(fs.readFileSync(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));
const ACTIONS = new Set(['accept', 'reject', 'stop']);

/** Инварианты — общий список для выбора; правильный — у своего случая. */
export function invariants() {
  return DATA.cases.map((c) => ({ id: c.id, text: c.invariant }));
}

/** Случаи для экрана: рассказ и неверный черновик (как его показала бы монтажная), без «правильного» ответа. */
export function rehearsalCases() {
  return DATA.cases.map((c) => {
    const { episode, dropped } = groundDraft(c.bad, c.story, { date: '2026-11-10' });
    return { id: c.id, name: c.name, story: c.story, episode, dropped: dropped.length };
  });
}

/**
 * Проверить решение организатора. expect=reject: верно — «отклонить» с инвариантом этого случая;
 * expect=stop: верно — «остановить» (инвариант не требуется). «Принять» неверно всегда:
 * в репетиции все черновики намеренно ошибочны.
 */
export function judge(id, action, invariantId) {
  const c = DATA.cases.find((x) => x.id === id);
  if (!c || !ACTIONS.has(action)) return null;
  const actionOk = action === c.expect;
  const invariantOk = c.expect === 'reject' ? invariantId === c.id : true;
  return {
    correct: actionOk && invariantOk,
    expected: c.expect,
    actionOk,
    invariantOk,
    invariant: c.invariant,
    why: c.why,
  };
}
