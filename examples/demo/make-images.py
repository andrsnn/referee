"""Draw the demo images: a target look (refs) and two rounds of a rough build (candidates).

All images are generated here, so the demo has no third-party art. Needs Pillow.
    python examples/demo/make-images.py
"""
import math
import os
import random
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 960, 540


def sky(d, top, bottom):
    for y in range(H):
        t = y / H
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)


def hills(d, base, amp, freq, phase, color):
    pts = [(0, H)]
    for x in range(0, W + 8, 8):
        pts.append((x, base + amp * math.sin(x * freq + phase) + amp * 0.4 * math.sin(x * freq * 2.7 + phase)))
    pts.append((W, H))
    d.polygon(pts, fill=color)


def fox(d, x, y, s, body, detail=True):
    d.ellipse([x, y, x + 60 * s, y + 34 * s], fill=body)                                        # body
    d.ellipse([x + 46 * s, y - 18 * s, x + 80 * s, y + 14 * s], fill=body)                       # head
    d.polygon([(x + 50 * s, y - 12 * s), (x + 56 * s, y - 34 * s), (x + 64 * s, y - 14 * s)], fill=body)
    d.polygon([(x + 64 * s, y - 14 * s), (x + 72 * s, y - 34 * s), (x + 78 * s, y - 10 * s)], fill=body)
    d.polygon([(x + 2 * s, y + 10 * s), (x - 38 * s, y - 6 * s), (x - 30 * s, y + 22 * s)], fill=body)  # tail
    if detail:
        d.polygon([(x - 38 * s, y - 6 * s), (x - 26 * s, y - 2 * s), (x - 30 * s, y + 8 * s)], fill=(250, 240, 225))
        d.ellipse([x + 66 * s, y - 6 * s, x + 71 * s, y - 1 * s], fill=(30, 20, 20))
        d.ellipse([x + 52 * s, y + 4 * s, x + 76 * s, y + 14 * s], fill=(250, 240, 225))
    for lx in (8, 22, 38, 50):
        d.rectangle([x + lx * s, y + 28 * s, x + (lx + 6) * s, y + 46 * s], fill=body)


def ui(d, hearts, coins, polished):
    for i in range(3):
        c = (230, 70, 90) if i < hearts else (90, 60, 70)
        x = 24 + i * 36
        if polished:
            d.ellipse([x, 22, x + 16, 38], fill=c); d.ellipse([x + 12, 22, x + 28, 38], fill=c)
            d.polygon([(x, 32), (x + 28, 32), (x + 14, 50)], fill=c)
        else:
            d.rectangle([x, 24, x + 24, 46], fill=c)
    d.ellipse([W - 130, 22, W - 106, 46], fill=(250, 205, 70))
    d.text((W - 96, 26), f"x {coins}", fill=(255, 255, 255) if polished else (200, 200, 200))


def target(seed, sun_x, fox_x, mist):
    random.seed(seed)
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    sky(d, (52, 40, 110), (250, 150, 110))
    d.ellipse([sun_x - 60, 250, sun_x + 60, 370], fill=(255, 220, 150))
    glow = im.filter(ImageFilter.GaussianBlur(30))
    im = Image.blend(im, glow, 0.5)
    d = ImageDraw.Draw(im)
    hills(d, 330, 30, 0.006, seed, (120, 80, 140))
    hills(d, 380, 26, 0.009, seed * 2, (80, 60, 110))
    if mist:
        layer = Image.new('RGB', (W, H), (240, 170, 160))
        im = Image.blend(im, layer, 0.18)
        d = ImageDraw.Draw(im)
    hills(d, 440, 18, 0.013, seed * 3, (40, 36, 70))
    for _ in range(14):                       # grass tufts
        gx = random.randint(0, W)
        d.polygon([(gx, 470), (gx + 6, 440), (gx + 12, 470)], fill=(60, 50, 90))
    fox(d, fox_x, 410, 1.0, (235, 120, 50))
    for i in range(5):                         # coins
        cx = 520 + i * 60
        d.ellipse([cx, 330 - 18 * math.sin(i), cx + 18, 348 - 18 * math.sin(i)], fill=(250, 205, 70))
    ui(d, 3, 12, True)
    return im


def rough(round_no, fox_x, cam):
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    if round_no == 1:
        d.rectangle([0, 0, W, H], fill=(110, 170, 230))          # flat blue sky, no sun
        d.rectangle([0, 430, W, H], fill=(70, 150, 70))           # flat green ground
        fox(d, fox_x, 380, 1.6, (200, 120, 60), detail=False)    # too big, no detail
        ui(d, 2, 3, False)
    else:
        sky(d, (90, 70, 140), (230, 150, 120))                   # gradient sky arrives
        hills(d, 400 + cam, 22, 0.008, 1.0, (90, 70, 120))
        d.rectangle([0, 450, W, H], fill=(50, 45, 80))
        fox(d, fox_x, 400, 1.2, (225, 120, 55), detail=True)
        for i in range(3):
            d.ellipse([560 + i * 70, 340, 578 + i * 70, 358], fill=(250, 205, 70))
        ui(d, 3, 7, False)
    return im


def save(im, *parts):
    f = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    im.save(f, quality=90)


save(target(1, 700, 220, True), 'refs', 'target-dusk-run.jpg')
save(target(2, 260, 520, True), 'refs', 'target-dusk-coins.jpg')
save(target(3, 480, 120, False), 'refs', 'target-clear-start.jpg')
save(rough(1, 200, 0), 'round1', 'build-run.jpg')
save(rough(1, 420, 0), 'round1', 'build-coins.jpg')
save(rough(2, 240, 0), 'round2', 'build-run.jpg')
save(rough(2, 520, -30), 'round2', 'build-coins.jpg')
save(rough(2, 120, 20), 'round2', 'build-start.jpg')
print('demo images written under', HERE)
