// Решение владельца 17:10 и редактор 18:25: временные строки исхода 2 с маркером «[срок не утверждён]»
// допустимы только на вымышленном стенде. Сборка для реальных данных (TITRY_RELEASE_REAL_DATA=1)
// не выпускается, пока маркер есть в коде. Обычный прогон проверяет, что маркер не показывается вне стенда.
// Решение Claude 19.11: в тексте согласия, который увидит участник, не должно быть ни одного поля в квадратных
// скобках — ни незаполненного («[контакт оператора]»), ни условного («[если включено]»).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CONSENT_TEXT } from '../server/consent.js';
import { TEXT } from '../server/bot.js';

// Регистр и «е/ё» не важны: «[Ждёт решения…]», «[ждет решения…]» — тоже маркеры.
const MARKER_RE = /\[\s*(?:жд[её]т решения|на согласование с юристом|срок не утвержд[её]н)[^\]\n]*\]?/giu;

// Все каталоги выпускаемого кода и текстов, рекурсивно.
const SHIPPED = ['server', 'engine', 'studio', 'config', 'concierge', 'brand', 'examples']; // examples/ отдаёт монтажная

// Тексты согласия проверяются как текст, а не как исходник: синтаксис JavaScript ([a, b], [а-я]) не мешает.
// Находка — любое поле в квадратных скобках (с любым началом, содержимым и переносами строк) и любая одиночная
// скобка «[» или «]»: бот отправляет согласие без разметки, участник увидит скобки как есть — и в ссылке тоже.
// Плюс условные куски в круглых скобках: «(если включено)», «(только для теста…)».
const bracketFields = (text) => [...String(text).matchAll(/\[[^\[\]]*\]|[\[\]]|\*?\((?=[^)]*(?:если\s+включ|только\s+(?:для\s+теста|если)))[^)]*\)\*?/giu)].map(([m]) => m);
// concierge/consent.md — шаблон: выше первой строки «---» инструкция организатору (чекбоксы режимов), участник
// видит только текст ниже неё.
const participantPart = (md) => { const i = md.search(/^---\s*$/m); assert.ok(i >= 0, 'в consent.md нет строки «---» перед текстом для участника'); return md.slice(i); };
const CONSENT_FILES = [new URL('../concierge/consent.md', import.meta.url)];

async function* files(dir) {
  // Ошибка чтения каталога — ошибка проверки, а не пропуск.
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) yield* files(p); else if (e.isFile()) yield p;
  }
}

test('поля в скобках: любое начало, содержимое, перенос, одиночная скобка, условия; чистый текст — без находок', () => {
  assert.deepEqual(bracketFields('Свяжитесь: [контакт оператора].'), ['[контакт оператора]']);
  assert.deepEqual(bracketFields('[ ждёт] [1 срок] [Operator] [-] [ ] []'), ['[ ждёт]', '[1 срок]', '[Operator]', '[-]', '[ ]', '[]']);
  assert.deepEqual(bracketFields('[ждёт решения:\nсрок]'), ['[ждёт решения:\nсрок]'], 'поле с переносом строки');
  assert.deepEqual(bracketFields('срок] и [без закрытия'), [']', '['], 'одиночные скобки');
  assert.deepEqual(bracketFields('Подробнее — [здесь](https://example.org).'), ['[здесь]'], 'ссылка тоже видна участнику как есть');
  assert.deepEqual(bracketFields('Голосовые *(если включено)* и (только для теста через монтажную).'), ['*(если включено)*', '(только для теста через монтажную)']);
  assert.deepEqual(bracketFields('(если включены) (если включён) (текстом или голосом — если включена расшифровка) (голосовые — если включено)'),
    ['(если включены)', '(если включён)', '(текстом или голосом — если включена расшифровка)', '(голосовые — если включено)']);
  assert.deepEqual(bracketFields('Окончательный текст без полей (по желанию — голосом), род (если сам об этом скажешь).'), []);
  assert.deepEqual([...'[Ждёт решения: контакт] [ждет решения] [срок не утвержден] [На согласование с юристом]'.matchAll(MARKER_RE)].length, 4, 'маркеры без учёта регистра и «ё»');
  assert.deepEqual(participantPart('- [ ] режим\n\n---\nТекст'), '---\nТекст', 'инструкция организатору выше «---» не проверяется');
});

test('выпуск для реальных данных: маркеров «[срок не утверждён]», «[ждёт решения…]», «[на согласование с юристом…]» нет в выпускаемом коде, полей в скобках нет в текстах согласия', { skip: process.env.TITRY_RELEASE_REAL_DATA !== '1' && 'только при TITRY_RELEASE_REAL_DATA=1' }, async () => {
  const found = [];
  for (const d of SHIPPED) {
    for await (const f of files(new URL(`../${d}/`, import.meta.url))) {
      const src = await fs.readFile(f, 'utf8'); // ошибка чтения — падение проверки
      for (const [m] of src.matchAll(MARKER_RE)) found.push(`«${m}» в ${f.pathname}`);
    }
  }
  for (const [key, text] of Object.entries(CONSENT_TEXT)) for (const m of bracketFields(text)) found.push(`«${m}» в CONSENT_TEXT.${key}`);
  // Остальные реплики бота участнику (server/bot.js, TEXT) — то же правило.
  for (const [key, v] of Object.entries(TEXT)) for (const m of bracketFields(typeof v === 'function' ? v() : v)) found.push(`«${m}» в TEXT.${key}`);
  for (const f of CONSENT_FILES) for (const m of bracketFields(participantPart(await fs.readFile(f, 'utf8')))) found.push(`«${m}» в ${f.pathname}`);
  assert.deepEqual(found, [], 'выпуск для реальных данных запрещён');
});
