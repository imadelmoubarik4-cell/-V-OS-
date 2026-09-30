# Composites the approved tray + hand into the original hero footage, keeping the real bird.
#   python3 compose.py            all 192 frames -> out/oNNN.png
#   python3 compose.py 60 97 192  selected frames
import cv2, numpy as np, json, os, sys
os.makedirs('out', exist_ok=True)
H, W = 720, 1280
tray = cv2.imread('tray_layer_wide.png', cv2.IMREAD_UNCHANGED).astype(np.float32)
T = {int(k): np.array(v, np.float32) for k, v in json.load(open('stab_closeup.json')).items()}
gx, gy = np.meshgrid(np.arange(W) / W, np.arange(H) / H)
AF = np.stack([np.ones_like(gx), gx, gy, gx ** 2, gy ** 2, gx * gy, gx ** 3, gy ** 3], -1)
rng = np.random.default_rng(7)

# Tray placement (reference px -> video px). The front-rim lip point (870, 705.5) of the
# reference goes under the toes: close-up (640, 565) at scale 0.80; wide shot (585, 700) at 0.64.
M_CLOSE = np.float32([[0.8, 0, 640 - 0.8 * 870], [0, 0.8, 565 - 0.8 * 705.5]])
M_WIDE = np.float32([[0.64, 0, 585 - 0.64 * 870], [0, 0.64, 700 - 0.64 * 705.5]])


def fit_plate(img, exclude):
    """Smooth model of the flat sage backdrop (cubic in x, y) from low-texture pixels."""
    L = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    std = np.sqrt(np.maximum(cv2.blur(L * L, (9, 9)) - cv2.blur(L, (9, 9)) ** 2, 0))
    ok = (std < 2.5) & ~exclude
    ys, xs = np.nonzero(ok[::4, ::4]); ys *= 4; xs *= 4
    A = AF[ys, xs].astype(np.float64)
    plate = np.zeros(img.shape, np.float32)
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A, img[ys, xs, c].astype(np.float64), rcond=None)
        plate[..., c] = AF @ coef
    return plate


def colours(img):
    b, g, r = [img[..., i].astype(np.int32) for i in range(3)]
    sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1].astype(np.int32)
    feathers = ((b > r + 15) & (b > 70)) | (((r - b) > 45) & (r > 110)) | (sat > 120)
    feet = ((r - b) > 60) & (r > 110)
    claw = (r + g + b) < 200
    return feathers, feet, claw


def bird_protect(img):
    """Pixels that belong to the bird: coloured feathers and feet, plus dark pixels (claws, dark
    wing tips) only where they touch those colours. The grey-brown twig is never included."""
    feathers, feet, claw = colours(img)
    coloured = cv2.morphologyEx((feathers | feet).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    # the bird is one large coloured region; brownish twig buds and knots are small separate specks
    n, lab, st, _ = cv2.connectedComponentsWithStats(coloured)
    coloured = np.isin(lab, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 1500])
    near = cv2.dilate(coloured.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))) > 0
    dark_touching = claw & near
    return cv2.dilate((coloured | dark_touching).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0


def twig_mask(img, plate, ymin, protect):
    """Grey-brown twig: differs from the backdrop, low saturation, not near-black, not the bird."""
    b, g, r = [img[..., i].astype(np.int32) for i in range(3)]
    sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1].astype(np.int32)
    diff = np.abs(img.astype(np.float32) - plate).sum(-1)
    m = (diff > 11) & (sat < 110) & ~protect
    m[:ymin] = False
    m = cv2.morphologyEx(m.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    return np.isin(lab, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] > 60])


def warp_tray(M):
    rgb = tray[..., :3] * (tray[..., 3:4] / 255.0)                     # premultiplied: no dark fringes
    flags = cv2.INTER_AREA if M[0, 0] < 1 else cv2.INTER_LINEAR
    wr = cv2.warpAffine(rgb, M, (W, H), flags=flags)
    wa = cv2.warpAffine(tray[..., 3], M, (W, H), flags=flags) / 255.0
    wr = cv2.GaussianBlur(wr, (0, 0), 0.55); wa = cv2.GaussianBlur(wa, (0, 0), 0.55)   # match the footage's softness
    return wr, np.clip(wa, 0, 1)


def bird_matte(img, plate, twig):
    """Soft alpha of the real bird from its distance to the backdrop (twig pixels excluded)."""
    d = np.sqrt(((img.astype(np.float32) - plate) ** 2).sum(-1))
    a = np.clip((d - 9.0) / 22.0, 0, 1)
    a[twig] = 0
    solid = (a > 0.5).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(solid)
    big = np.isin(lab, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] > 400])
    near = cv2.dilate(big.astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
    a[~near] = 0                                                        # drop specks far from the bird
    core = cv2.morphologyEx(big.astype(np.uint8) * 255, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))) > 0
    core = cv2.erode(core.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    a[core & ~twig & (d > 16)] = 1.0                                    # solid interior only where it is not backdrop
    return np.clip(a, 0, 1)


def composite(img, plate, twig, M, clean_below, feet_zone=None):
    feathers, feet, claw = colours(img)
    grain = rng.normal(0, 1.3, img.shape).astype(np.float32)
    base = img.astype(np.float32)
    tw = cv2.GaussianBlur(twig.astype(np.float32), (0, 0), 1.0)[..., None]
    base = base * (1 - tw) + np.clip(plate + grain, 0, 255) * tw          # twig painted out
    # below the perch line only the bird's own body (and 15 px around it) is kept; everything else there
    # is twig or backdrop and becomes clean backdrop
    near = cv2.dilate(bird_protect(img).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))) > 0
    low = np.zeros(near.shape, bool); low[clean_below:] = True
    wipe = low & ~near
    base[wipe] = np.clip(plate[wipe] + grain[wipe], 0, 255)
    a = bird_matte(img, plate, twig)
    a[wipe] = 0
    if feet_zone is not None:
        # where the toes grip the rim, keep only the orange toes and the near-black claws touching them;
        # the twig strand under the toes (grey-brown) and the backdrop inside the curled claws go
        x0, y0, x1, y1 = feet_zone
        feathers, feet, claw = colours(img)
        toes = cv2.dilate(feet.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        near_toes = cv2.dilate(feet.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))) > 0
        b_, g_, r_ = [img[..., i].astype(np.int32) for i in range(3)]
        claws = ((r_ + g_ + b_) < 240) & near_toes
        keep = toes | claws
        zone = np.zeros(a.shape, bool); zone[y0:y1, x0:x1] = True
        zone &= ~(feathers & ~feet)                                      # never cut belly or tail feathers
        sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1]
        remove = zone & ~keep & (sat < 75)                               # grey-brown twig and backdrop only
        a[remove] = 0
        base[remove] = np.clip(plate[remove] + grain[remove], 0, 255)
        a[zone & keep] = np.maximum(a[zone & keep], 0.85)
    a = a[..., None]
    trgb, ta = warp_tray(M)
    # contact shadows where toes/claws touch the tray, and a soft shadow of the body on the tray
    contact = cv2.GaussianBlur(((feet | claw) & (a[..., 0] > 0.5)).astype(np.float32), (0, 0), 2.2)
    contact = np.clip(contact * 2.2, 0, 1)
    body = cv2.GaussianBlur(np.roll(a[..., 0], 8, axis=0), (0, 0), 10)
    trgb = trgb * (1 - np.clip(0.6 * contact + 0.22 * body, 0, 0.75))[..., None]
    trgb = trgb + grain * 0.8 * ta[..., None]
    # Layering without touching the original pixels outside the tray:
    #   out = base + (1 - a) * (tray_over_backdrop - backdrop)
    # Outside the tray this is exactly the original frame (twig removed); inside it the tray shows
    # through wherever the bird is absent or partly transparent (a = bird alpha).
    under = plate * (1 - ta[..., None]) + trgb
    out = base + (1 - a) * (under - plate)
    return np.clip(out, 0, 255).astype(np.uint8)


# static twig masks (wide shot is locked off; close-up is stabilised to its final frame)
f1 = cv2.imread('full/f001.png'); P1 = fit_plate(f1, np.zeros((H, W), bool))
TWIG_WIDE = cv2.dilate(twig_mask(f1, P1, 600, bird_protect(f1)).astype(np.uint8),
                       cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))) > 0
fl = cv2.imread('full/f192.png'); PL = fit_plate(fl, np.zeros((H, W), bool))
PROT = bird_protect(fl)
TWIG_CLOSE = cv2.dilate(twig_mask(fl, PL, 440, PROT).astype(np.uint8),
                        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0

FEET_ZONE = (500, 548, 700, 610)   # stabilised close-up: toes and claws on the rim
frames = range(1, 193) if len(sys.argv) < 2 else [int(x) for x in sys.argv[1:]]
for i in frames:
    img = cv2.imread(f'full/f{i:03d}.png')
    if i <= 96:                                                          # wide shot
        tw = TWIG_WIDE & ~bird_protect(img)
        plate = fit_plate(img, tw | (np.sqrt(((img.astype(np.float32) - P1) ** 2).sum(-1)) > 14))
        out = composite(img, plate, tw, M_WIDE, 630)
    else:                                                                # close-up, stabilised on the perch
        Minv = cv2.invertAffineTransform(T[i])
        st = cv2.warpAffine(img, Minv, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        valid = cv2.warpAffine(np.ones((H, W), np.uint8), Minv, (W, H), flags=cv2.INTER_NEAREST, borderValue=0) > 0
        tw = TWIG_CLOSE & ~bird_protect(st)
        plate = fit_plate(st, tw | (np.sqrt(((st.astype(np.float32) - PL) ** 2).sum(-1)) > 14) | ~valid)
        stf = st.astype(np.float32)
        stf[~valid] = plate[~valid] + rng.normal(0, 1.3, (int((~valid).sum()), 3))
        out = composite(np.clip(stf, 0, 255).astype(np.uint8), plate, tw, M_CLOSE, 440, FEET_ZONE)
    cv2.imwrite(f'out/o{i:03d}.png', out)
print('done', len(list(frames)))
