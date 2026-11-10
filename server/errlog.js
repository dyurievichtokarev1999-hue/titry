// ИР-03 (критик реализации): обезличенный журнал ошибок. В журнал попадают только этап, код, время и версия —
// без сообщения, стека, текста рассказа, строк, путей и идентификаторов. Сообщения и стеки исключений
// могут содержать фрагменты рассказа (ошибки API, проверки, распознавания), поэтому их не пишем вовсе.
import fs from 'node:fs';

let version = 'unknown';
try { version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'; } catch { /* остаётся unknown */ }

// Код — только короткий машинный идентификатор (ENOENT, safety, timeout, HTTP-статус). Всё остальное — 'error'.
export function safeCode(e) {
  for (const c of [e?.code, e?.status, e?.name]) {
    const s = c === undefined || c === null ? '' : String(c);
    if (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(s) || /^[0-9]{3}$/.test(s)) return s;
  }
  return 'error';
}

export function logError(stage, e, sink = console.error) {
  sink(JSON.stringify({ at: new Date().toISOString(), level: 'error', stage, code: safeCode(e), version }));
}
