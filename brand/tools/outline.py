"""Перевести надписи логотипа в кривые (SVG-контуры), чтобы логотип не зависел от установленных шрифтов.
Нужен fontTools с brotli:  pip install fonttools brotli
Запуск из корня проекта:     python brand/tools/outline.py
"""
import os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.path.join(ROOT, 'engine', 'fonts')
OUT = os.path.join(ROOT, 'brand')

class Face:
    def __init__(self, *files):
        self.fonts = [TTFont(os.path.join(FONTS, f)) for f in files]
        self.upm = self.fonts[0]['head'].unitsPerEm
    def glyph(self, ch):
        for f in self.fonts:
            name = f.getBestCmap().get(ord(ch))
            if name:
                return f, name
        raise KeyError(ch)
    def run(self, text, size, x, y, tracking=0.0):
        """Контуры строки: size — кегль в px, tracking — разрядка в долях кегля. Возвращает (d, ширина)."""
        scale = size / self.upm
        parts = []
        cx = x
        for i, ch in enumerate(text):
            f, name = self.glyph(ch)
            gs = f.getGlyphSet()
            pen = SVGPathPen(gs)
            gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, cx, y)))
            parts.append(pen.getCommands())
            cx += f['hmtx'][name][0] * scale
            if i < len(text) - 1:
                cx += tracking * size
        return ' '.join(p for p in parts if p), cx - x

forum = Face('forum-cyrillic-400-normal.woff2', 'forum-latin-400-normal.woff2')
mono = Face('jetbrains-mono-cyrillic-500-normal.woff2', 'jetbrains-mono-latin-500-normal.woff2')

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{body}</svg>\n')

def wordmark(color, with_descriptor):
    size, track = 120, 0.32
    _, width = forum.run('ТИТРЫ', size, 0, 0, track)
    pad = 40
    W = width + pad * 2
    H = 230 if with_descriptor else 170
    d, _ = forum.run('ТИТРЫ', size, pad, 130, track)
    body = f'<path fill="{color}" d="{d}"/>'
    if with_descriptor:
        dsize, dtrack = 22, 0.24
        _, dw = mono.run('ФИЛЬМ О ТВОЁМ ДНЕ', dsize, 0, 0, dtrack)
        dd, _ = mono.run('ФИЛЬМ О ТВОЁМ ДНЕ', dsize, (W - dw) / 2, 196, dtrack)
        body += f'<path fill="{color}" fill-opacity=".7" d="{dd}"/>'
    return svg(W, H, body, 'Титры')

def axis(color):
    size, track, gap = 110, 0.12, 34
    _, w1 = forum.run('тит', size, 0, 0, track)
    _, w2 = forum.run('ры', size, 0, 0, track)
    pad = 40
    W = pad * 2 + w1 + gap * 2 + w2
    d1, _ = forum.run('тит', size, pad, 120, track)
    d2, _ = forum.run('ры', size, pad + w1 + gap * 2, 120, track)
    ax = pad + w1 + gap
    body = (f'<path fill="{color}" d="{d1} {d2}"/>'
            f'<rect x="{ax - 1.5:.1f}" y="28" width="3" height="120" fill="{color}" fill-opacity=".5"/>')
    return svg(W, 176, body, 'Титры')

for name, content in {
    'logo-wordmark-light.svg': wordmark('#F1E9DA', True),
    'logo-wordmark-ink.svg': wordmark('#15120F', True),
    'logo-wordmark-light-short.svg': wordmark('#F1E9DA', False),
    'logo-axis-light.svg': axis('#F1E9DA'),
    'logo-axis-ink.svg': axis('#15120F'),
}.items():
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as fh:
        fh.write(content)
    print('ok', name)
