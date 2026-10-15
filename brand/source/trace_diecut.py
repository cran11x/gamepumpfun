# Trace the logo's die-cut silhouette (rendered by logo.html#mask) into a smooth closed SVG path -> diecut.js
# usage: python3 trace_diecut.py mask.png scale diecut.js
#   mask.png: RGBA render where the die-cut region is opaque white; scale = deviceScaleFactor used for the render.
import sys
import numpy as np
from PIL import Image

src, scale, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
a = np.array(Image.open(src).convert('RGBA'))[:, :, 3]
m = a > 127
H, W = m.shape
m = np.pad(m, 1)

# Moore-neighbour boundary tracing of the outer contour (the blob has no meaningful holes)
ys, xs = np.nonzero(m)
i0 = np.lexsort((xs, ys))[0]
start = (ys[i0], xs[i0])
nb = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]  # clockwise from N
cur = start
back = 6  # came from the west
pts = [cur]
for _ in range(4 * (H + W) * 8):
    found = False
    for k in range(8):
        d = (back + 1 + k) % 8
        ny, nx = cur[0] + nb[d][0], cur[1] + nb[d][1]
        if m[ny, nx]:
            back = (d + 4) % 8
            cur = (ny, nx)
            found = True
            break
    if not found:
        break
    if cur == start and len(pts) > 2:
        break
    pts.append(cur)
P = np.array(pts, dtype=float)[:, ::-1] - 1.0 + 0.5  # (x, y), undo pad, pixel centers
print('contour points', len(P))

# circular gaussian smoothing
def smooth(P, sigma):
    n = len(P); r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    ext = np.concatenate([P[-r:], P, P[:r]])
    return np.stack([np.convolve(ext[:, j], k, mode='valid') for j in range(2)], axis=1)

S = smooth(P, sigma=3.0 * scale)
# resample uniformly by arc length
seg = np.hypot(*np.diff(np.vstack([S, S[:1]]), axis=0).T)
cum = np.concatenate([[0], np.cumsum(seg)])
L = cum[-1]
step = 7.0 * scale
n = max(32, int(L / step))
tt = np.linspace(0, L, n, endpoint=False)
R = np.stack([np.interp(tt, cum, np.append(S[:, j], S[0, j])) for j in range(2)], axis=1) / scale

# closed Catmull-Rom -> cubic Bezier
def f(v):
    return f'{v:.1f}'.rstrip('0').rstrip('.')
d = f'M{f(R[0,0])} {f(R[0,1])}'
N = len(R)
for i in range(N):
    p0, p1, p2, p3 = R[(i - 1) % N], R[i], R[(i + 1) % N], R[(i + 2) % N]
    c1 = p1 + (p2 - p0) / 6
    c2 = p2 - (p3 - p1) / 6
    d += f'C{f(c1[0])} {f(c1[1])} {f(c2[0])} {f(c2[1])} {f(p2[0])} {f(p2[1])}'
d += 'Z'
with open(out, 'w') as fh:
    fh.write('// Logo die-cut outline traced from logo.html#mask by trace_diecut.py\nwindow.DIECUT = "' + d + '";\n')
print('segments', N, 'bytes', len(d), 'bbox', R.min(0).round(1), R.max(0).round(1))
