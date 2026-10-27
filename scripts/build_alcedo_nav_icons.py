"""ALCEDO navigation glyphs: drawn for the product, not taken from a kit.

Construction (256 grid, Phosphor-compatible weight so the set stays one
family): 16-unit centre lines, round caps and round joins, containers with a
12-unit centre-line corner radius. The signature is the beak corner: every
container keeps ONE sharp corner, top right, where the ALCEDO symbol's beak
points; a roof or a bowl that already comes to a point keeps that point
sharp. Lines are stroked to filled outlines with skia-pathops.
"""
import json, math, re, sys
import pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen

W = 16
R = 12  # centre-line corner radius

def num(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    if s in ('-0', ''): s = '0'
    if s.startswith('0.'): s = s[1:]
    elif s.startswith('-0.'): s = '-' + s[2:]
    return s

def minify(d):
    out, prev = [], None
    for tok in re.findall(r'[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d):
        if tok.isalpha():
            out.append(tok); prev = None; continue
        n = num(float(tok))
        if prev is not None and not n.startswith('-') and not (n.startswith('.') and '.' in prev):
            out.append(',')
        out.append(n); prev = n
    return ''.join(out)

def path_of(d):
    p = pathops.Path(); parse_path(d, p.getPen()); return p

def stroke(d, width=W, join='round'):
    p = path_of(d)
    j = {'round': pathops.LineJoin.ROUND_JOIN, 'miter': pathops.LineJoin.MITER_JOIN}[join]
    cap = pathops.LineCap.ROUND_CAP if join == 'round' else pathops.LineCap.BUTT_CAP
    p.stroke(width, cap, j, 10)
    p.convertConicsToQuads()
    return p

def union(*paths):
    out = pathops.Path()
    for p in paths: out = pathops.op(out, p, pathops.PathOp.UNION)
    return out

def minus(a, b): return pathops.op(a, b, pathops.PathOp.DIFFERENCE)

def to_d(p):
    p = pathops.Path(p); p.convertConicsToQuads()
    pen = SVGPathPen(None, ntos=num); p.draw(pen)
    return minify(pen.getCommands())

def circle(cx, cy, r):
    return f'M{cx - r},{cy}a{r},{r} 0 1,0 {2 * r},0a{r},{r} 0 1,0 {-2 * r},0Z'

def disc(cx, cy, r): return path_of(circle(cx, cy, r))

def rrect(x0, y0, x1, y1, r=R, sharp='tr'):
    """Closed centre line of a rectangle with rounded corners except `sharp`."""
    c = {k: (0 if k in sharp else r) for k in ('tl', 'tr', 'br', 'bl')}
    d = f'M{x0 + c["tl"]},{y0}H{x1 - c["tr"]}'
    if c['tr']: d += f'A{r},{r} 0 0,1 {x1},{y0 + r}'
    d += f'V{y1 - c["br"]}'
    if c['br']: d += f'A{r},{r} 0 0,1 {x1 - r},{y1}'
    d += f'H{x0 + c["bl"]}'
    if c['bl']: d += f'A{r},{r} 0 0,1 {x0},{y1 - r}'
    d += f'V{y0 + c["tl"]}'
    if c['tl']: d += f'A{r},{r} 0 0,1 {x0 + r},{y0}'
    return d + 'Z'

def contour(d):
    """A closed outline drawn with mitre joins (its sharp corners stay sharp;
    its rounded corners are arcs, so they join smoothly anyway)."""
    return stroke(d, W, 'miter')

G = {}

# Home: the roof is the open A of the symbol, its apex left sharp; a door.
G['house'] = union(
    contour('M44,208V124Q44,116 50,111L128,44L206,111Q212,116 212,124V208Q212,216 204,216H52Q44,216 44,208Z'),
    stroke('M104,216V164Q104,156 112,156H144Q152,156 152,164V216'))

# Messages: a front bubble (beak corner top right) and a second bubble behind.
G['chats-alcedo'] = union(
    contour('M44,40H168V140Q168,152 156,152H92L52,184V152H44Q32,152 32,140V52Q32,40 44,40Z'),
    stroke('M200,96H212Q224,96 224,108V196Q224,208 212,208H204V232L172,208H112Q100,208 100,196V184'))

# Operations: a clipboard with the check of a done task.
G['clipboard-alcedo'] = union(
    contour(rrect(48, 48, 208, 224)),
    stroke('M96,48V36Q96,28 104,28H152Q160,28 160,36V48V60Q160,68 152,68H104Q96,68 96,60Z'),
    stroke('M92,144L116,168L164,120'))

# Inventory: a bar's stock is bottles: cap (the beak corner), neck,
# shoulders and the label band. Not a box (archive is the box).
BOTTLE = 'M112,64V80Q68,96 68,140V212Q68,224 80,224H176Q188,224 188,212V140Q188,96 144,80V64'
def bottle(): return union(contour(rrect(104, 28, 152, 64, r=8)), stroke(BOTTLE), stroke('M68,148H188M68,192H188'))
G['bottle-alcedo'] = bottle()
GAP = 16
def badge(base, strokes):
    return union(minus(base, stroke(strokes, W + 2 * GAP)), stroke(strokes))
BADGE_PLUS = 'M196,156V232M158,194H234'
BADGE_X = 'M168,168L224,224M224,168L168,224'
G['bottle-plus-alcedo'] = badge(bottle(), BADGE_PLUS)
G['bottle-x-alcedo'] = badge(bottle(), BADGE_X)

# Recipes: the cocktail glass; its bowl comes to the beak point on the right.
G['martini-alcedo'] = union(
    contour('M44,40H220L128,140L40,48Q36,40 44,40Z'),
    stroke('M128,140V220M84,220H172'),
    stroke(circle(116, 84, 14)))

# Purchasing: a delivery truck; the cab's windscreen is the beak diagonal.
G['truck-alcedo'] = union(
    stroke('M152,180H104M56,180H32Q20,180 20,168V68Q20,56 32,56H140Q152,56 152,68V180'),
    contour('M152,92H196L240,140V168Q240,180 228,180H216M160,180H152Z'),
    stroke(circle(80, 184, 24)), stroke(circle(188, 184, 24)))

def calendar(extra):
    return union(
        contour(rrect(32, 48, 224, 224)),
        stroke('M80,28V68M176,28V68M32,96H224'), *extra)

# Bookings: a calendar with a confirmed booking.
G['calendar-check-alcedo'] = calendar([stroke('M92,156L116,180L164,132')])
# Shifts: a calendar of days on the rota.
G['calendar-days-alcedo'] = calendar([disc(x, y, 12) for x in (84, 128, 172) for y in (140, 184)])

G['calendar-blank-alcedo'] = calendar([])
G['calendar-plus-alcedo'] = calendar([stroke('M128,128V192M96,160H160')])

# Team: two people, the nearer one whole.
G['users-alcedo'] = union(
    stroke(circle(96, 96, 40)),
    stroke('M24,208Q36,152 96,152Q156,152 168,208'),
    stroke('M152,59A40,40 0 1,1 172,136Q216,140 232,196'))

# Knowledge: an open book; the right page carries the beak corner.
G['book-alcedo'] = union(
    stroke('M128,72Q128,48 104,48H40Q28,48 28,60V188Q28,200 40,200H104Q128,200 128,224'),
    contour('M128,72Q128,48 152,48H228V188Q228,200 216,200H152Q128,200 128,224Z'))

# Reports: three bars on a base line; the tallest has the beak corner.
G['chart-alcedo'] = union(
    stroke('M24,216H232'),
    stroke(rrect(40, 136, 80, 216, sharp='')),
    stroke(rrect(108, 96, 148, 216, sharp='')),
    contour(rrect(176, 40, 216, 216)))

# Marketing: a megaphone; its mouth ends in the beak corner.
G['megaphone-alcedo'] = union(
    contour('M40,84Q40,72 52,72H104L224,24V216L104,168H52Q40,168 40,156Z'),
    stroke('M104,72V168'),
    stroke('M72,168L88,220Q90,228 98,228H116Q126,228 123,218L108,170'))

# Accounting: an upright receipt with its torn foot; the beak corner top right.
G['receipt-alcedo'] = union(
    contour('M76,32H200V216L176,200L152,216L128,200L104,216L80,200L56,216V44Q56,32 68,32Z'),
    stroke('M92,80H164M92,120H164M92,160H136'))

# Menu Pricing: a price tag whose point is the beak; the hole and a percent.
G['tag-percent-alcedo'] = union(
    contour('M28,40Q28,28 40,28H128L232,132L132,232L28,128Z'),
    stroke(circle(80, 80, 14)),
    stroke('M112,180L180,112'), disc(116, 128, 11), disc(164, 176, 11))

# Data: the stored layers of a cylinder.
G['database-alcedo'] = union(
    stroke('M40,64A88,32 0 1,0 216,64A88,32 0 1,0 40,64Z'),
    stroke('M40,64V192A88,32 0 0,0 216,192V64'),
    stroke('M40,128A88,32 0 0,0 216,128'))

# Settings: a six-tooth gear around its hub.
def gear(cx=128, cy=128, ro=100, ri=78, teeth=6, tw=0.42):
    pts = []
    for i in range(teeth):
        a = 2 * math.pi * i / teeth - math.pi / 2
        half = math.pi / teeth
        a0, a1 = a - half * tw, a + half * tw
        b0, b1 = a + half * (1 - tw) * 0.0 + half * tw * 1.25, a + 2 * half - half * tw * 1.25
        pts.append(('L', cx + ro * math.cos(a0), cy + ro * math.sin(a0)))
        pts.append(('L', cx + ro * math.cos(a1), cy + ro * math.sin(a1)))
        pts.append(('L', cx + ri * math.cos(b0), cy + ri * math.sin(b0)))
        pts.append(('A', cx + ri * math.cos(b1), cy + ri * math.sin(b1)))
    d = f'M{pts[0][1]:.2f},{pts[0][2]:.2f}'
    for kind, x, y in pts[1:] + [pts[0]]:
        d += f'A{ri},{ri} 0 0,1 {x:.2f},{y:.2f}' if kind == 'A' else f'L{x:.2f},{y:.2f}'
    return d + 'Z'
G['gear-alcedo'] = union(stroke(gear()), stroke(circle(128, 128, 32)))

out = {k: to_d(v) for k, v in G.items()}
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else 'nav.json', 'w'), indent=1)
print('\n'.join(f'{k}: {len(v)}' for k, v in out.items()))
