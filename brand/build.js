// Экспорт растровых файлов бренда из SVG: иконки приложения, аватар и обложка бота, лист бренда.
// Запуск: npm run brand  (нужен playwright)
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'png');
await fs.mkdir(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');

const read = (f) => fs.readFile(path.join(here, f), 'utf8');
// Шрифты встраиваются как data: URI: страница из setContent не может читать file://
const fontDir = path.join(here, '..', 'engine', 'fonts');
let fontsCss = await fs.readFile(path.join(fontDir, 'fonts.css'), 'utf8');
for (const f of (await fs.readdir(fontDir)).filter((x) => x.endsWith('.woff2'))) {
  const b64 = (await fs.readFile(path.join(fontDir, f))).toString('base64');
  fontsCss = fontsCss.replaceAll(`url("${f}")`, `url("data:font/woff2;base64,${b64}")`);
}
const icon = await read('icon.svg');
const wordmark = await read('logo-wordmark-light.svg');
const wordmarkShort = await read('logo-wordmark-light-short.svg');
const axisInk = await read('logo-axis-ink.svg');
const wordInk = await read('logo-wordmark-ink.svg');

const page = (body, w, h, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${fontsCss}
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#15120F}
svg{display:block}${extra}</style></head><body>${body}</body></html>`;

const jobs = [];
for (const size of [1024, 512, 192, 180, 64, 32]) {
  jobs.push({ file: `icon-${size}.png`, w: size, h: size, html: page(icon.replace('width="1024" height="1024"', `width="${size}" height="${size}"`), size, size) });
}
// Аватар бота: Telegram обрезает кругом, поэтому знак уменьшен и центрирован
jobs.push({ file: 'telegram-avatar-640.png', w: 640, h: 640, html: page(`<div style="width:640px;height:640px;display:grid;place-items:center;background:radial-gradient(circle at 50% 78%,rgba(220,182,140,.22),transparent 70%) #15120F">${icon.replace('width="1024" height="1024"', 'width="520" height="520"')}</div>`, 640, 640) });
// Картинка описания бота 640×360
jobs.push({ file: 'telegram-cover-640x360.png', w: 640, h: 360, html: page(`
<div style="width:640px;height:360px;display:grid;place-items:center;align-content:center;gap:18px;background:radial-gradient(ellipse at 50% 90%,rgba(220,182,140,.25),transparent 60%) #15120F">
  <div style="width:440px">${wordmarkShort.replace(/width="[\d.]+" height="[\d.]+"/, 'width="100%" height="auto"')}</div>
  <div style="font:400 30px/1.2 Forum,serif;color:#F1E9DA;text-align:center">Каждый день заслуживает титров</div>
  <div style="font:500 13px/1 'JetBrains Mono',monospace;letter-spacing:.24em;color:#DCB68C">РАССКАЖИ ДЕНЬ · ПОЛУЧИ ФИЛЬМ</div>
</div>`, 640, 360) });
// Лист бренда — для быстрого просмотра всего комплекта
const swatch = (c, n, h) => `<div style="display:grid;gap:6px"><div style="height:70px;border-radius:6px;background:${c};border:1px solid #3A332B"></div><b style="font:600 14px Golos Text;color:#F1E9DA">${n}</b><span style="font:500 11px JetBrains Mono;color:#9A907F">${h}</span></div>`;
jobs.push({ file: 'brand-sheet.png', w: 1200, h: 700, html: page(`
<div style="padding:56px;display:grid;gap:40px;font-family:Golos Text">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center">
    <div style="background:#0E0C0A;border:1px solid #2F2922;border-radius:10px;padding:36px;display:grid;place-items:center">${wordmark.replace(/width="[\d.]+" height="[\d.]+"/, 'width="380" height="auto"')}</div>
    <div style="background:#F1E9DA;border-radius:10px;padding:36px;display:grid;place-items:center;gap:20px">${axisInk.replace(/width="[\d.]+" height="[\d.]+"/, 'width="260" height="auto"')}</div>
  </div>
  <div style="display:flex;gap:28px;align-items:center">
    ${icon.replace('width="1024" height="1024"', 'width="140" height="140" style="border-radius:32px"')}
    ${icon.replace('width="1024" height="1024"', 'width="72" height="72" style="border-radius:16px"')}
    ${icon.replace('width="1024" height="1024"', 'width="36" height="36" style="border-radius:8px"')}
    <div style="margin-left:24px;display:grid;gap:8px">
      <div style="font:400 44px/1.1 Forum;color:#F1E9DA">Письмо, которое ушло</div>
      <div style="font:500 14px JetBrains Mono;letter-spacing:.16em;color:#DCB68C">ЖАНР: ТЁПЛАЯ ДРАМА</div>
      <div style="font:400 17px Golos Text;color:#D9CFBD">Что сегодня было? Можно сумбурно, одного момента достаточно.</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:14px">
    ${swatch('#15120F', 'Зал', '#15120F')}${swatch('#F1E9DA', 'Проектор', '#F1E9DA')}${swatch('#DCB68C', 'Янтарь', '#DCB68C')}
    ${swatch('#B4C3D5', 'Сумерки', '#B4C3D5')}${swatch('#E3AD98', 'Терракота', '#E3AD98')}${swatch('#C4C5BA', 'Шалфей', '#C4C5BA')}
  </div>
</div>`, 1200, 700) });

const browser = await chromium.launch();
try {
  for (const j of jobs) {
    const p = await browser.newPage({ viewport: { width: j.w, height: j.h } });
    await p.setContent(j.html, { waitUntil: 'load' });
    await p.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))); await document.fonts.ready; });
    await p.screenshot({ path: path.join(out, j.file), omitBackground: false });
    await p.close();
    console.log('ok', j.file);
  }
} finally { await browser.close(); }
