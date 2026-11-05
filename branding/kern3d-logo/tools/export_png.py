import sys, os
from PIL import Image
d = sys.argv[1]
big = Image.open(os.path.join(d, "kern3d-mark-1024.png")).convert("RGBA")
small = Image.open(os.path.join(d, "kern3d-mark-small-1024.png")).convert("RGBA")
def pick(s): return small if s <= 32 else big
for s in (16, 24, 32, 48, 64, 128, 180, 192, 256, 512):
    pick(s).resize((s, s), Image.LANCZOS).save(os.path.join(d, f"kern3d-icon-{s}.png"))
frames = [pick(s).resize((s, s), Image.LANCZOS) for s in (16, 24, 32, 48, 64, 128, 256)]
frames[-1].save(os.path.join(d, "kern3d.ico"), format="ICO", sizes=[f.size for f in frames], append_images=frames[:-1])
ico = Image.open(os.path.join(d, "kern3d.ico")); print("ico sizes:", sorted(ico.info.get("sizes", [])))
