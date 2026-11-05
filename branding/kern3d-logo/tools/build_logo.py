"""Kern3D logo builder: SVG masters (text in curves) for concept 1C."""
import math, os, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FONT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

INK, ACC, F1, F2, F3, TAG = "#1F2429", "#FF6A13", "#EEF1F3", "#B5BEC6", "#5E6A75", "#8A949C"
HALO = "#8A949C"

def font_at(w):
    f = TTFont(FONT)
    return instantiateVariableFont(f, {"wght": w})

def text_path(font, text, x, baseline, cap_h, tracking=0.0):
    """Return (svg path d, advance width) for text; cap_h = height of capitals in output units."""
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    cap = font["OS/2"].sCapHeight or 700
    s = cap_h / cap
    pen = SVGPathPen(gs)
    cx = x
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (s, 0, 0, -s, cx, baseline)))
        cx += (font["hmtx"][g][0] + tracking * font["head"].unitsPerEm) * s
    return pen.getCommands(), cx - x

C = (128.0, 76.0)  # top-face centre
def iso(t, sx, sy):
    return (C[0] + 0.8660254 * t * sx, C[1] + 0.5 * t * sy)

def mark(outline=INK, halo=None, small=False):
    hexd = "M128,24 L218.07,76 V180 L128,232 L37.93,180 V76 Z"
    y = "M37.93,76 L128,128 L218.07,76 M128,128 V232"
    sw = 20 if small else 12
    parts = []
    if halo:
        parts.append(f'<path d="{hexd}" fill="none" stroke="{halo}" stroke-width="{sw+14}" stroke-linejoin="round"/>')
    parts += [
        f'<polygon points="128,24 218.07,76 128,128 37.93,76" fill="{F1}"/>',
        f'<polygon points="37.93,76 128,128 128,232 37.93,180" fill="{F2}"/>',
        f'<polygon points="128,128 218.07,76 218.07,180 128,232" fill="{F3}"/>',
        f'<path d="{hexd} {y}" fill="none" stroke="{outline}" stroke-width="{sw}" stroke-linejoin="round"/>',
    ]
    if small:
        parts.append(f'<ellipse cx="128" cy="76" rx="36" ry="20.78" fill="{ACC}"/>')
    else:
        parts.append(f'<ellipse cx="128" cy="76" rx="24" ry="13.86" fill="none" stroke="{ACC}" stroke-width="8"/>')
        ticks = []
        for sx, sy in ((1, 1), (-1, -1), (1, -1), (-1, 1)):
            a, b = iso(28, sx, sy), iso(41, sx, sy)
            ticks.append(f"M{a[0]:.2f},{a[1]:.2f} L{b[0]:.2f},{b[1]:.2f}")
        parts.append(f'<path d="{" ".join(ticks)}" stroke="{ACC}" stroke-width="8" stroke-linecap="round"/>')
        parts.append(f'<ellipse cx="128" cy="76" rx="8.5" ry="4.91" fill="{ACC}"/>')
    return "\n  ".join(parts)

def svg(w, h, body, vb=None):
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}">\n  {body}\n</svg>\n'

def write(name, data):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        fh.write(data)

# --- marks
write("kern3d-mark.svg", svg(256, 256, mark()))
write("kern3d-mark-dark.svg", svg(256, 256, mark(halo=HALO)))
write("kern3d-mark-small.svg", svg(256, 256, mark(small=True)))
write("kern3d-mark-small-dark.svg", svg(256, 256, mark(small=True, halo=HALO)))

# --- lockup (horizontal): mark + wordmark + tag
bold, semi = font_at(800), font_at(600)
X0 = 262
d_kern, w_kern = text_path(bold, "Kern", X0, 160, 112)
d_3d, w_3d = text_path(bold, "3D", X0 + w_kern + 4, 160, 112)
d_tag, w_tag = text_path(semi, "ОТ GENESIS TACTICAL", X0 + 4, 212, 22, tracking=0.16)
W = math.ceil(X0 + max(w_kern + 4 + w_3d, w_tag + 4) + 12)

def lockup(dark):
    word = "#EEF1F3" if dark else INK
    m = mark(halo=HALO) if dark else mark()
    return svg(W, 256, f"""<g>{m}</g>
  <path d="{d_kern}" fill="{word}"/>
  <path d="{d_3d}" fill="{ACC}"/>
  <path d="{d_tag}" fill="{TAG}"/>""")

write("kern3d-logo.svg", lockup(False))
write("kern3d-logo-dark.svg", lockup(True))

# --- wordmark only
WW = math.ceil(w_kern + 4 + w_3d + 8)
dk, _ = text_path(bold, "Kern", 4, 112, 112)
d3, _ = text_path(bold, "3D", 4 + w_kern + 4, 112, 112)
write("kern3d-wordmark.svg", svg(WW, 116, f'<path d="{dk}" fill="{INK}"/>\n  <path d="{d3}" fill="{ACC}"/>'))
write("kern3d-wordmark-dark.svg", svg(WW, 116, f'<path d="{dk}" fill="#EEF1F3"/>\n  <path d="{d3}" fill="{ACC}"/>'))
print("ok", W, WW)
