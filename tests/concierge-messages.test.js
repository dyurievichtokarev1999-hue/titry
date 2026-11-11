// Ручной шаблон срочной остановки (concierge/messages.md, раздел «Безопасность»):
// дословно утверждённый текст, отсылка к контактам из config/help.json, без обещаний и без фразы о новом рассказе.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { STOP_SCREEN_TEXT } from '../server/safety.js';

const APPROVED = 'Титры для этого рассказа не будут собраны. Если тебе или кому-то рядом прямо сейчас угрожает опасность, позвони по одному из номеров ниже или попроси человека рядом побыть с тобой.';
const md = await fs.readFile(new URL('../concierge/messages.md', import.meta.url), 'utf8');
const section = (title) => {
  const m = md.match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  assert.ok(m, `раздел «${title}» есть`);
  return m[1];
};

test('шаблон остановки: дословно утверждённый текст, как на экране бота', () => {
  const s = section('Безопасность');
  assert.ok(s.includes(`> ${APPROVED}\n`), 'утверждённый текст — отдельной строкой цитаты');
  assert.equal(STOP_SCREEN_TEXT, APPROVED, 'совпадает с текстом экрана остановки');
  assert.match(s, /config\/help\.json/, 'отсылка к действующему блоку контактов');
});

test('шаблон остановки: без обещаний и без фразы о новом рассказе', () => {
  const s = section('Безопасность');
  assert.doesNotMatch(s, /Я на связи/);
  assert.doesNotMatch(s, /найду контакты/);
  assert.doesNotMatch(s, /Сейчас важнее не титры/);
  assert.doesNotMatch(s, /нов\S* рассказ|Когда захочется|прислать/i);
});

test('остальные шаблоны на месте', () => {
  assert.match(section('Ответы на отклик'), /Стало тяжелее/);
  assert.match(section('Отправка ролика'), /Титры твоего дня/);
});
