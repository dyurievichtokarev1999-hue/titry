// Решение владельца 17:10 и редактор 18:25: временные строки исхода 2 с маркером «[срок не утверждён]»
// допустимы только на вымышленном стенде. Сборка для реальных данных (TITRY_RELEASE_REAL_DATA=1)
// не выпускается, пока маркер есть в коде. Обычный прогон проверяет, что маркер не показывается вне стенда.
// Решение Claude 19.11: в тексте согласия, который увидит участник, не должно быть ни одного поля в квадратных
// скобках — ни незаполненного («[контакт оператора]»), ни условного («[если включено]»).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CONSENT_TEXT } from '../server/consent.js';

const MARKERS = ['[срок не утверждён]', '[ждёт решения', '[на согласование с юристом'];

// Все каталоги выпускаемого кода и текстов, рекурсивно.
const SHIPPED = ['server', 'engine', 'studio', 'config', 'concierge', 'brand'];

// Тексты согласия проверяются как текст, а не как исходник: синтаксис JavaScript ([a, b], [а-я]) не мешает.
// Поле — любые квадратные скобки в пределах строки, с любым началом и содержимым, включая пустые «[ ]».
// Ссылка Markdown «[текст](адрес)» — не поле.
const bracketFields = (text) => [...String(text).matchAll(/\[[^\]\n]*\](?!\()/g)].map(([m]) => m);
const CONSENT_FILES = [new URL('../concierge/consent.md', import.meta.url)];

async function* files(dir) {
  // Ошибка чтения каталога — ошибка проверки, а не пропуск.
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* files(p); else if (e.isFile()) yield p;
  }
}

test('поля в скобках: любое начало и содержимое; чистый текст и ссылки — без находок', () => {
  assert.deepEqual(bracketFields('Свяжитесь: [контакт оператора].'), ['[контакт оператора]']);
  assert.deepEqual(bracketFields('[ ждёт] [1 срок] [Operator] [-] [ ] []'), ['[ ждёт]', '[1 срок]', '[Operator]', '[-]', '[ ]', '[]']);
  assert.deepEqual(bracketFields('Окончательный текст без полей. Подробнее — [здесь](https://example.org).'), []);
  assert.deepEqual(bracketFields('[начало\nпереноса]'), [], 'поле в пределах строки');
});

test('выпуск для реальных данных: маркеров «[срок не утверждён]», «[ждёт решения…]», «[на согласование с юристом…]» нет в выпускаемом коде, полей в скобках нет в текстах согласия', { skip: process.env.TITRY_RELEASE_REAL_DATA !== '1' && 'только при TITRY_RELEASE_REAL_DATA=1' }, async () => {
  const found = [];
  for (const d of SHIPPED) {
    for await (const f of files(new URL(`../${d}/`, import.meta.url))) {
      const src = await fs.readFile(f, 'utf8'); // ошибка чтения — падение проверки
      for (const m of MARKERS) if (src.includes(m)) found.push(`«${m}» в ${f.pathname}`);
    }
  }
  for (const [key, text] of Object.entries(CONSENT_TEXT)) for (const m of bracketFields(text)) found.push(`«${m}» в CONSENT_TEXT.${key}`);
  for (const f of CONSENT_FILES) for (const m of bracketFields(await fs.readFile(f, 'utf8'))) found.push(`«${m}» в ${f.pathname}`);
  assert.deepEqual(found, [], 'выпуск для реальных данных запрещён');
});
