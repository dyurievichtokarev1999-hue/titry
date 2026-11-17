// Таймлайн и прокрутка по разбору моушн-дизайнера GPT от 7.11.2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline, rollPosition } from '../engine/draw.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('v2: 1,5 с пустой темноты и 3,5 с полной видимости сцены после титров', () => {
  const T = timeline(24, 'v2');
  const textGone = T.blackStart + T.sceneFade;
  assert.ok(near(T.postStart - textGone, 1.5), 'пустая темнота без фейдов');
  const fullFrom = T.postStart + T.postFadeIn;
  const fullTo = T.duration - T.fadeOut;
  assert.ok(near(fullTo - fullFrom, 3.5), 'полная видимость последней фразы');
  assert.ok(near(T.blackStart - T.rollEnd, T.endHold));
});

test('v1 не изменился', () => {
  const T = timeline(24);
  assert.equal(T.variant, 'v1');
  assert.ok(near(T.rollEnd, 17.8) && near(T.blackStart, 19.1) && near(T.postStart, 20.6));
});

test('ровная прокрутка: монотонна, без ускорения в середине', () => {
  let prev = -1;
  for (let i = 0; i <= 100; i++) { const p = rollPosition(i / 100, 'linear', 0.08); assert.ok(p >= prev); prev = p; }
  assert.ok(near(rollPosition(0, 'linear'), 0) && near(rollPosition(1, 'linear'), 1));
  const mid = (rollPosition(0.55, 'linear', 0.08) - rollPosition(0.45, 'linear', 0.08)) / 0.1;
  const edge = (rollPosition(0.25, 'linear', 0.08) - rollPosition(0.15, 'linear', 0.08)) / 0.1;
  assert.ok(Math.abs(mid - edge) < 1e-9, 'скорость в середине равна скорости в начале основной зоны');
  const smoothPeak = (rollPosition(0.55) - rollPosition(0.45)) / 0.1;
  assert.ok(smoothPeak > 1.45, 'исходная кривая ускоряется до ~1,5× в середине');
});
