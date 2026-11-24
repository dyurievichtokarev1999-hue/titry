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
import { markerHits, bracketFields, unfinishedTexts } from '../server/release.js'; // то же правило — при старте бота
import { prepareBot } from '../server/bot.js';

// Все каталоги выпускаемого кода и текстов, рекурсивно.
const SHIPPED = ['server', 'engine', 'studio', 'config', 'concierge', 'brand', 'examples']; // examples/ отдаёт монтажная

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
  assert.deepEqual(markerHits('[Ждёт решения: контакт] [ждет решения] [срок не утвержден] [На согласование с юристом]').length, 4, 'маркеры без учёта регистра и «ё»');
  assert.deepEqual(participantPart('- [ ] режим\n\n---\nТекст'), '---\nТекст', 'инструкция организатору выше «---» не проверяется');
});

test('выпуск для реальных данных: маркеров «[срок не утверждён]», «[ждёт решения…]», «[на согласование с юристом…]» нет в выпускаемом коде, полей в скобках нет в текстах согласия', { skip: process.env.TITRY_RELEASE_REAL_DATA !== '1' && 'только при TITRY_RELEASE_REAL_DATA=1' }, async () => {
  const found = [];
  for (const d of SHIPPED) {
    for await (const f of files(new URL(`../${d}/`, import.meta.url))) {
      const src = await fs.readFile(f, 'utf8'); // ошибка чтения — падение проверки
      for (const m of markerHits(src)) found.push(`«${m}» в ${f.pathname}`);
    }
  }
  for (const [key, text] of Object.entries(CONSENT_TEXT)) for (const m of bracketFields(text)) found.push(`«${m}» в CONSENT_TEXT.${key}`);
  // Остальные реплики бота участнику (server/bot.js, TEXT) — то же правило.
  for (const [key, v] of Object.entries(TEXT)) for (const m of bracketFields(typeof v === 'function' ? v() : v)) found.push(`«${m}» в TEXT.${key}`);
  for (const f of CONSENT_FILES) for (const m of bracketFields(participantPart(await fs.readFile(f, 'utf8')))) found.push(`«${m}» в ${f.pathname}`);
  assert.deepEqual(found, [], 'выпуск для реальных данных запрещён');
});

// Предмортем G0, п. 1: старт бота на реальных данных сам выполняет проверку — до очистки, хранилища и приёма сообщений.
test('старт бота с TITRY_RELEASE_REAL_DATA=1: тексты не окончательные — отказ release_texts до очистки; в журнале только ключи', async () => {
  const lines = []; let cleaned = 0; let loaded = 0;
  const env = { METRICS_SALT: 'test-salt-fictional-0001', TITRY_RELEASE_REAL_DATA: '1', ANTHROPIC_API_KEY: 'dummy-not-a-key', TITRY_VOICE: 'off' };
  // Контрольная заглушка: вымышленные тексты с незаполненным и условным полем (не зависят от текущих текстов).
  const texts = { CONSENT_TEXT: { pd: 'Пишите: [контакт оператора], срок [ждёт решения: срок].', ready: 'Голосом (если включено).' }, TEXT: { start: 'Привет.', fn: () => 'Пока.' } };
  const keys = ['CONSENT_TEXT.pd', 'CONSENT_TEXT.ready'];
  await assert.rejects(prepareBot({ env, texts, log: (l) => lines.push(l), checkRender: async () => {}, cleanup: async () => { cleaned++; }, cleanupTmp: async () => { cleaned++; return 0; }, ledger: { load: async () => { loaded++; } } }),
    { code: 'release_texts', stage: 'release.texts' });
  assert.equal(cleaned + loaded, 0, 'ни очистки, ни хранилища');
  const rec = JSON.parse(lines.find((l) => l.includes('release_texts')));
  assert.deepEqual(rec.keys, keys);
  for (const w of ['ждёт решения', 'контакт оператора', 'если включено']) assert.ok(!lines.join('\n').includes(w), `содержимое текстов не в журнале: ${w}`);
  // Чистая вымышленная сборка: тот же старт проходит проверку текстов и идёт дальше (очистка, хранилище).
  await prepareBot({ env, log: () => {}, texts: { CONSENT_TEXT: { pd: 'Окончательный вымышленный текст.' }, TEXT: { start: 'Привет.' } }, checkRender: async () => {}, cleanup: async () => { cleaned++; }, cleanupTmp: async () => { cleaned++; return 0; }, ledger: { load: async () => { loaded++; } } });
  assert.equal(cleaned + loaded, 3, 'чистые тексты — старт продолжается');
});

test('проверка текстов: чистые тексты проходят, поле в любом тексте группы — его ключ', () => {
  assert.deepEqual(unfinishedTexts({ A: { ok: 'Готово.', fn: () => 'Тоже готово.' } }), []);
  assert.deepEqual(unfinishedTexts({ A: { ok: 'Готово.', bad: 'Пишите: [контакт]' }, B: { cond: () => 'Голос (если включено).' } }), ['A.bad', 'B.cond']);
});
