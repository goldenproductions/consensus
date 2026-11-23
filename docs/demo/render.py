# Render ANSI (truecolor SGR) frames to PNGs. Usage: python render.py <frames_dir> <cols> <rows>
import os, re, sys
from PIL import Image, ImageDraw, ImageFont

frames_dir, COLS, ROWS = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
BG = (13, 17, 23)
SIZE = 30                      # rendered at 2x, downscaled at the end for smooth text
F = 'C:/Windows/Fonts/'
mono = ImageFont.truetype(F + 'CascadiaMono.ttf', SIZE)
monob = ImageFont.truetype(F + 'CascadiaMono.ttf', SIZE)
try:
    monob.set_variation_by_name('Bold')
except Exception:
    pass
sym = ImageFont.truetype(F + 'seguisym.ttf', int(SIZE * 0.85))
CW = int(mono.getlength('M'))
asc, desc = mono.getmetrics()
CH = int((asc + desc) * 1.08)
PAD = 2 * CW

nd = bytes(mono.getmask('\U000F0000'))
cache = {}
def has(c):
    if c not in cache:
        cache[c] = bytes(mono.getmask(c)) != nd
    return cache[c]

SGR = re.compile(r'\x1b\[([0-9;]*)m')

def parse(text):
    rows = []
    for line in text.split('\n')[:ROWS]:
        fg, bold, cells, i = (200, 200, 200), False, [], 0
        for m in SGR.finditer(line):
            for ch in line[i:m.start()]:
                cells.append((ch, fg, bold))
            p = [int(x) if x else 0 for x in m.group(1).split(';')]
            j = 0
            while j < len(p):
                v = p[j]
                if v == 0: fg, bold = (200, 200, 200), False
                elif v == 1: bold = True
                elif v == 22: bold = False
                elif v == 38 and j + 4 < len(p) and p[j + 1] == 2:
                    fg = tuple(p[j + 2:j + 5]); j += 4
                elif v == 48 and j + 4 < len(p) and p[j + 1] == 2:
                    j += 4
                j += 1
            i = m.end()
        for ch in line[i:]:
            cells.append((ch, fg, bold))
        rows.append(cells)
    return rows

def render(text, out):
    W, H = COLS * CW + 2 * PAD, ROWS * CH + 2 * PAD
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    for r, cells in enumerate(parse(text)):
        y = PAD + r * CH
        for c, (ch, fg, bold) in enumerate(cells[:COLS]):
            if ch == ' ':
                continue
            x = PAD + c * CW
            if has(ch):
                d.text((x, y), ch, font=monob if bold else mono, fill=fg)
            else:  # symbol fallback, centred in the cell
                w = sym.getlength(ch)
                d.text((x + (CW - w) / 2, y + CH * 0.08), ch, font=sym, fill=fg)
    img = img.resize((W // 2, H // 2), Image.LANCZOS)
    img.save(out)

names = sorted(n for n in os.listdir(frames_dir) if n.endswith('.ans'))
for n in names:
    with open(os.path.join(frames_dir, n), encoding='utf-8') as f:
        render(f.read(), os.path.join(frames_dir, n[:-4] + '.png'))
print(len(names), 'frames rendered')
