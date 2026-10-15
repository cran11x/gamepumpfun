# Extract Bungee glyph outlines (font units, y-up) into glyphs.js for text->path conversion.
# usage: PYTHONPATH=<fonttools> python3 make_glyphs.py fonts/Bungee-Regular.ttf glyphs.js
import sys, json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
src, out = sys.argv[1], sys.argv[2]
f = TTFont(src)
gs = f.getGlyphSet(); cmap = f.getBestCmap(); hmtx = f['hmtx']
chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%-$!?.,:'+&/ "
out_g = {}
for ch in chars:
    gn = cmap.get(ord(ch))
    if not gn: continue
    pen = SVGPathPen(gs)
    gs[gn].draw(pen)
    out_g[ch] = {"d": pen.getCommands(), "adv": hmtx[gn][0]}
with open(out, 'w') as fh:
    fh.write("// Bungee (SIL OFL 1.1) glyph outlines in font units (y-up), used to convert <text> to <path>.\n")
    fh.write("window.BUNGEE = " + json.dumps({"upm": f['head'].unitsPerEm, "glyphs": out_g}) + ";\n")
print(len(out_g), 'glyphs')
