# Logo check sheet on dark / white / gold / purple, plus 128px and 64px sizes.
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
print('mode', im.mode, 'size', im.size, 'corner alpha', im.getpixel((5, 5))[3], 'bbox', im.getbbox())
bgs = [(7, 9, 13), (255, 255, 255), (255, 212, 0), (153, 69, 255)]
sheet = Image.new('RGB', (1660, 600), (128, 128, 128))
for i, bg in enumerate(bgs):
    t = Image.new('RGBA', im.size, bg + (255,)); t.alpha_composite(im)
    sheet.paste(t.resize((400, 400), Image.LANCZOS).convert('RGB'), (10 + i * 412, 10))
    for j, sz in enumerate((128, 64)):
        s = Image.new('RGBA', (sz, sz), bg + (255,)); s.alpha_composite(im.resize((sz, sz), Image.LANCZOS))
        sheet.paste(s.convert('RGB'), (10 + i * 412 + j * 150, 430))
sheet.save(out); print('saved', out)
