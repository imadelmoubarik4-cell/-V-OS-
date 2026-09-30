# Builds a clean RGBA layer of tray + hand + sleeve from the approved reference (ref.webp),
# removing the reference bird and rebuilding the tray pixels it hid.
import cv2, numpy as np
ref = cv2.imread('ref.webp'); H, W = ref.shape[:2]
f = ref.astype(np.float32)
b, g, r = [ref[..., i].astype(int) for i in range(3)]
hsv = cv2.cvtColor(ref, cv2.COLOR_BGR2HSV); sat = hsv[..., 1].astype(int)
gx, gy = np.meshgrid(np.arange(W) / W, np.arange(H) / H)

# 1. Backdrop model (smooth sage gradient), fitted on the top 55 % and the bottom-left corner
L = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY).astype(np.float32)
std = np.sqrt(np.maximum(cv2.blur(L * L, (11, 11)) - cv2.blur(L, (11, 11)) ** 2, 0))
sage = (g > r) & (g > b) & (std < 2.5) & (sat < 60) & ((r + g + b) > 480)
ys, xs = np.nonzero(sage[::3, ::3]); ys *= 3; xs *= 3
A = np.stack([np.ones_like(xs), xs / W, ys / H, (xs / W) ** 2, (ys / H) ** 2, xs * ys / (W * H)], 1).astype(np.float64)
Af = np.stack([np.ones_like(gx), gx, gy, gx ** 2, gy ** 2, gx * gy], -1)
plate = np.zeros_like(f)
for c in range(3):
    coef, *_ = np.linalg.lstsq(A, f[ys, xs, c].astype(np.float64), rcond=None)
    plate[..., c] = Af @ coef
dist = np.sqrt(((f - plate) ** 2).sum(-1))

# 2. Foreground (tray, hand, sleeve, bird) alpha from backdrop distance
alpha = np.clip((dist - 10) / 28, 0, 1)
alpha[:560] = 0                                            # nothing of the tray/hand above y=560
# 3. Reference bird mask: turquoise/orange/cream feathers, legs; plus everything left of the tray tip
bird = ((b > r + 15) & (b > 80)) | (((r - b) > 45) & (sat > 70) & (r > 110)) | ((r > 150) & (g > 120) & (b < 150) & (r - b > 25))
bird = cv2.morphologyEx(bird.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
bird[:, :560] = 255
bird[:560] = 255
# the hand (skin) is also warm: keep it out of the bird mask (hand is right of x=840, below y=770)
skin_zone = np.zeros_like(bird); skin_zone[770:, 840:] = 255
bird[skin_zone > 0] = 0
bird = cv2.dilate(bird, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))

# 4. Tray geometry (ellipse fitted to the visible rim, x >= 880): centre x 1250, tip x 662
XC, TIP, CY, B0, WALL = 1250.0, 662.0, 658.0, 62.2, 68.0
def half(x):
    t = np.clip((XC - x) / (XC - TIP), -1, 1)
    return B0 * np.sqrt(np.clip(1 - t * t, 0, 1))
def back(x):  return CY - half(x)
def front(x): return CY + half(x)
def bottom(x): return front(x) + WALL * np.sqrt(np.clip(half(x) / B0, 0, 1))

out = np.dstack([ref.copy(), (alpha * 255).astype(np.uint8)])
zone = (bird > 0) & (np.arange(W)[None, :] >= TIP - 2) & (np.arange(H)[:, None] >= 560)
# Left section (tip .. x=905) is rebuilt entirely from the tray geometry: the reference bird's
# tail, feet and claws cover most of it. Only the tray body (back outline .. underside) is filled.
REBUILD_X = 905
colx = np.arange(W)[None, :].repeat(H, 0).astype(np.float64); rowy = np.arange(H)[:, None].repeat(W, 1)
left = (colx >= TIP) & (colx < REBUILD_X)
zone = zone | (left & (rowy >= back(colx) - 1) & (rowy < bottom(colx) + 1))
zy, zx = np.nonzero(zone)
period = 96
d = (REBUILD_X - 1 - zx) % (2 * period)                      # anchored at the seam: x=904 samples x=905
xs_src = REBUILD_X + np.where(d < period, d, 2 * period - 1 - d)   # mirrored (seamless) tiling of the nearest clean band
xf = zx.astype(np.float64)
yb, yf, ybt = back(xf), front(xf), bottom(xf)
res_rgb = np.zeros((len(zx), 3), np.uint8); res_a = np.zeros(len(zx), np.uint8)
top = (zy >= yb) & (zy < yf)
v = (zy[top] - yb[top]) / np.maximum(yf[top] - yb[top], 1)
sy = back(xs_src[top]) + v * (front(xs_src[top]) - back(xs_src[top]))
res_rgb[top] = ref[np.clip(np.round(sy).astype(int), 0, H - 1), xs_src[top]]; res_a[top] = 255
wall = (zy >= yf) & (zy < ybt)
u = (zy[wall] - yf[wall]) / np.maximum(ybt[wall] - yf[wall], 1)
sy = front(xs_src[wall]) + u * (bottom(xs_src[wall]) - front(xs_src[wall]))
res_rgb[wall] = ref[np.clip(np.round(sy).astype(int), 0, H - 1), xs_src[wall]]; res_a[wall] = 255
orig_rgb = ref[zy, zx]; orig_clean = ~(bird[zy, zx] > 0)
wx = np.clip((zx - (REBUILD_X - 45)) / 45.0, 0, 1)[:, None] * orig_clean[:, None]
res_rgb = (res_rgb * (1 - wx) + orig_rgb * wx).astype(np.uint8)
out[zy, zx, :3] = res_rgb; out[zy, zx, 3] = res_a
# soften the rebuilt outline (1 px) and remove anything left of the tip
a = out[..., 3].astype(np.float32)
a[:, :int(TIP)] = 0
# nothing of the layer lies above the tray's top outline; in the rebuilt section nothing lies outside the tray body
above = rowy < back(np.clip(colx, TIP, None)) - 1
a[above & (colx < 1400)] = 0
a[left & (colx < 845) & (rowy >= bottom(colx) + 1) & (rowy < 790)] = 0
sm = cv2.GaussianBlur(a, (0, 0), 0.8)
a = np.where(zone, sm, a)
out[..., 3] = np.clip(a, 0, 255).astype(np.uint8)
# de-spill: colour of semi-transparent edge pixels = (I - (1-a) * plate) / a
aa = out[..., 3:4].astype(np.float32) / 255
edge = (aa[..., 0] > 0.05) & (aa[..., 0] < 0.95)
unmix = np.clip((out[..., :3].astype(np.float32) - (1 - aa) * plate) / np.maximum(aa, 0.05), 0, 255)
out[..., :3][edge] = unmix[edge].astype(np.uint8)
cv2.imwrite('tray_layer.png', out)
np.save('tray_geom.npy', np.array([XC, TIP, CY, B0, WALL]))
# previews
def over(bg):
    c = np.full((H, W, 3), bg, np.float32); a = out[..., 3:4] / 255.0
    return (out[..., :3] * a + c * (1 - a)).astype(np.uint8)
cv2.imwrite('tray_layer_check.png', cv2.resize(np.vstack([over((176, 196, 182)), over((255, 255, 255))])[:, 480:], None, fx=0.6, fy=0.6))
print('zone px', len(zx), 'top', int(top.sum()), 'wall', int(wall.sum()))

# ---- Right end (the reference crops the tray at x=1671; the tip is ~x 1730) -----------------
# Right-side geometry fitted to the visible columns x 1500..1671: centre y 657, half-height
# 61*sqrt(1-((x-1250)/480)^2) scaled to 32 px at x=1671, underside 38 px below the lip there.
PAD = 90
RC, RA, RCY, RH0 = 1250.0, 480.0, 657.0, 61.0
k = 32.0 / (RH0 * np.sqrt(1 - ((1671 - RC) / RA) ** 2))
def rhalf(x): return k * RH0 * np.sqrt(np.clip(1 - ((x - RC) / RA) ** 2, 0, 1))
def rback(x): return RCY - rhalf(x)
def rfront(x): return RCY + rhalf(x)
def rbottom(x): return rfront(x) + 38.0 * np.clip(rhalf(x) / 32.0, 0, None)   # tapers to the tip
wide = np.zeros((H, W + PAD, 4), np.uint8); wide[:, :W] = out
xs_new = np.arange(W, W + PAD)
for x in xs_new:
    hb, hf, hbt = rback(x), rfront(x), rbottom(x)
    if hf - hb < 1: continue
    d = (x - W) % 192; xs = 1671 - (d if d < 96 else 191 - d)          # mirrored band 1576..1671 anchored at the edge
    for y in range(int(np.floor(hb)), int(np.ceil(hbt)) + 1):
        if y < hb - 0.5 or y > hbt + 0.5: continue
        if y < hf:
            v = (y - hb) / max(hf - hb, 1); sy = rback(xs) + v * (rfront(xs) - rback(xs))
        else:
            u = (y - hf) / max(hbt - hf, 1); sy = rfront(xs) + u * (rbottom(xs) - rfront(xs))
        wide[y, x, :3] = ref[int(np.clip(round(sy), 0, H - 1)), xs]
        cov = min(1.0, y - hb + 0.5, hbt - y + 0.5)
        wide[y, x, 3] = int(255 * max(0.0, cov))
cv2.imwrite('tray_layer_wide.png', wide)
c = np.full((H, W + PAD, 3), (176, 196, 182), np.float32); aa = wide[..., 3:4] / 255.0
cv2.imwrite('tray_right_zoom.png', cv2.resize((wide[..., :3] * aa + c * (1 - aa)).astype(np.uint8)[560:800, 1450:W + PAD], None, fx=2.5, fy=2.5))
print('right end built, layer', wide.shape)
