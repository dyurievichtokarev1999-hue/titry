// Ручной шаблон срочной остановки (concierge/messages.md, раздел «Безопасность»):
// дословно утверждённый текст, отсылка к контактам из config/help.json, без обещаний и без фразы о новом рассказе.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { STOP_SCREEN_TEXT } from '../server/safety.js';

const APPROVED = 'Для этого рассказа ролика не будет. Если тебе или кому-то рядом сейчас угрожает опасность, звони 112.';
const md = await fs.readFile(new URL('../concierge/messages.md', import.meta.url), 'utf8');
const section = (title) => {
  const m = md.match(new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  assert.ok(m, `раздел «${title}» есть`);
  return m[1];
};

test('шаблон остановки: цитата — только утверждённый текст и блок контактов из config/help.json', () => {
  const s = section('Безопасность');
  const quote = s.split('\n').filter((l) => l.startsWith('>'));
  assert.deepEqual(quote, [`> ${APPROVED}`, '>', '> [блок контактов — из config/help.json]'],
    'в сообщении участнику нет ничего, кроме утверждённого текста и контактов');
  assert.equal(STOP_SCREEN_TEXT, APPROVED, 'совпадает с текстом экрана остановки');
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
