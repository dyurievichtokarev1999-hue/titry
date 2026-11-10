// «Репетиция» R16–R20, часть 2 (ИР-05): режим монтажной для организатора.
// Организатор видит намеренно неверный черновик модели по вымышленному рассказу редактора и выбирает действие:
// принять, отклонить с указанием нарушенного инварианта или остановить (сигнал безопасности).
// Это упражнение: ролик в репетиции не собирается, ответы организатора не записываются никуда.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { groundDraft } from './draft.js';

const DATA = JSON.parse(fs.readFileSync(new URL('../rehearsal/r16-r20.json', import.meta.url), 'utf8'));
const ACTIONS = new Set(['accept', 'reject', 'stop']);

// Инварианты для выбора — только у случаев «отклонить» (R20 — «остановить», его инвариант подсказал бы ответ).
// Непрозрачные id и порядок по тексту: по списку нельзя сопоставить инвариант со случаем; сопоставление — только в judge.
const invId = (c) => `inv-${crypto.createHash('sha256').update(`rehearsal\0${c.id}\0${c.invariant}`).digest('hex').slice(0, 8)}`;
const INVARIANTS = DATA.cases.filter((c) => c.expect === 'reject')
  .map((c) => ({ id: invId(c), text: c.invariant }))
  .sort((a, b) => a.text.localeCompare(b.text, 'ru'));

export function invariants() {
  return INVARIANTS.map((i) => ({ ...i }));
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
  const invariantOk = c.expect === 'reject' ? invariantId === invId(c) : true;
  return {
    correct: actionOk && invariantOk,
    expected: c.expect,
    actionOk,
    invariantOk,
    invariant: c.invariant,
    why: c.why,
  };
}
