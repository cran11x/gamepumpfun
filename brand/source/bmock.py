# Banner safe-zone mock: desktop (600px wide, avatar overlay), mobile (60px top/bottom crop, 390 wide), and guides.
# usage: python3 bmock.py banner.png avatar.png out.png
import sys
from PIL import Image, ImageDraw
bn, av, out = sys.argv[1:4]
b = Image.open(bn).convert('RGBA'); a = Image.open(av).convert('RGBA')
def circ(im, size, border, bcol):
    big = im.resize((size * 4, size * 4), Image.LANCZOS)
    m = Image.new('L', big.size, 0); ImageDraw.Draw(m).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    c = Image.new('RGBA', big.size, (0, 0, 0, 0)); c.paste(big, (0, 0), m)
    c = c.resize((size, size), Image.LANCZOS)
    t = Image.new('RGBA', (size + 2 * border, size + 2 * border), (0, 0, 0, 0))
    ImageDraw.Draw(t).ellipse((0, 0, t.size[0] - 1, t.size[1] - 1), fill=bcol)
    t.alpha_composite(c, (border, border)); return t
W = 1640
sheet = Image.new('RGB', (W, 1240), (40, 40, 40))
d = ImageDraw.Draw(sheet)
# 1) desktop at 600px: banner 600x200, avatar 134px (+4 border) at left 16, overlapping bottom
for i, bg in enumerate([(0, 0, 0), (255, 255, 255)]):
    page = Image.new('RGBA', (600, 300), bg + (255,))
    page.alpha_composite(b.resize((600, 200), Image.LANCZOS), (0, 0))
    page.alpha_composite(circ(a, 134, 4, bg + (255,)), (12, 128))
    sheet.paste(page.convert('RGB'), (20 + i * 620, 20))
# 2) mobile: crop 60px top/bottom -> 1500x380 shown at 390 wide; avatar ~80px overlapping bottom-left
mob = b.crop((0, 60, 1500, 440)).resize((390, 99), Image.LANCZOS)
page = Image.new('RGBA', (390, 170), (0, 0, 0, 255)); page.alpha_composite(mob, (0, 0))
page.alpha_composite(circ(a, 80, 3, (0, 0, 0, 255)), (10, 56))
sheet.paste(page.convert('RGB').resize((780, 340), Image.LANCZOS), (20, 340))
# 3) full res with guides
g = b.convert('RGB'); gd = ImageDraw.Draw(g, 'RGBA')
gd.rectangle((0, 330, 400, 500), fill=(255, 0, 255, 70)); gd.rectangle((0, 0, 1500, 60), fill=(0, 255, 255, 50)); gd.rectangle((0, 440, 1500, 500), fill=(0, 255, 255, 50))
gd.line((420, 0, 420, 500), fill=(0, 255, 255, 255), width=2)
sheet.paste(g.convert('RGB').resize((1500, 500)), (20, 700))
sheet.save(out); print('saved', out)
