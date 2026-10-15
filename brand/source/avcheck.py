# Avatar check sheet: circle crop at 400, then 96/48/32 px on X black, X dim and white, plus a 48px x5 zoom.
# usage: python3 avcheck.py out.png in1.png [in2.png ...]
import sys
from PIL import Image, ImageDraw
out, ins = sys.argv[1], sys.argv[2:]
BGS = [(0, 0, 0), (21, 32, 43), (255, 255, 255)]
def circ(im, size):
    big = im.resize((size * 4, size * 4), Image.LANCZOS)
    m = Image.new('L', big.size, 0); ImageDraw.Draw(m).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    c = Image.new('RGBA', big.size, (0, 0, 0, 0)); c.paste(big, (0, 0), m)
    return c.resize((size, size), Image.LANCZOS)
rowh = 420 + 120 + 250
sheet = Image.new('RGB', (max(1, len(ins)) * 760, rowh), (128, 128, 128))
for i, p in enumerate(ins):
    im = Image.open(p).convert('RGBA')
    ox = i * 760 + 10
    c400 = circ(im, 400)
    tile = Image.new('RGBA', (400, 400), (0, 0, 0, 255)); tile.alpha_composite(c400)
    sheet.paste(tile.convert('RGB'), (ox, 10))
    # 96/48/32 on three bgs
    y = 10
    for j, bg in enumerate(BGS):
        x = ox + 420
        t = Image.new('RGB', (330, 110), bg)
        cx = 8
        for sz in (96, 48, 32):
            c = circ(im, sz)
            t.paste(c, (cx, (110 - sz) // 2), c)
            cx += sz + 16
        sheet.paste(t, (x, y + j * 125))
    # 48 x5 zoom on black and white
    for j, bg in enumerate([(0, 0, 0), (255, 255, 255)]):
        c = circ(im, 48)
        t = Image.new('RGB', (48, 48), bg); t.paste(c, (0, 0), c)
        z = t.resize((240, 240), Image.NEAREST)
        sheet.paste(z, (ox + j * 250, 430 + 110))
    # 32 x5
    c = circ(im, 32); t = Image.new('RGB', (32, 32), (21, 32, 43)); t.paste(c, (0, 0), c)
    sheet.paste(t.resize((160, 160), Image.NEAREST), (ox + 510, 430 + 110))
sheet.save(out)
print('saved', out)
