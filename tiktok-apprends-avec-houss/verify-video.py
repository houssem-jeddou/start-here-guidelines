#!/usr/bin/env python3
"""Contrôle du fichier livré.

  python3 verify-video.py

- ffprobe : 1080x1920, 30 fps, H.264, yuv420p, durée 15-20 s, pas de piste audio
- dernière image fixe au moins 1,5 s (ffmpeg freezedetect)
- extrait une image au milieu de chaque scène dans controle/scene-N.png (décodage BT.709)
- couleurs : chaque pixel doit être une des 3 couleurs de la charte ou un mélange
  de deux d'entre elles (anticrénelage) ; les zones hors charte sont listées.
  Contrôle strict sur un rendu sans perte des mêmes instants (render.cjs stills),
  et sur les images du MP4 seulement les zones pleines (le sous-échantillonnage
  4:2:0 crée des liserés d'une couleur intermédiaire au bord des lettres).
- zones sûres : hors du rectangle x 110-970 / y 190-1500, l'image doit être le fond uni
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
VIDEO = ROOT / "tiktok-video-v1.mp4"
COVER = ROOT / "cover.png"
CONTROLE = ROOT / "controle"

NAVY, YELLOW, WHITE = (15, 23, 42), (250, 204, 21), (255, 255, 255)
PALETTE = np.array([NAVY, YELLOW, WHITE], dtype=np.float32)
SAFE = (110, 190, 970, 1500)  # x0, y0, x1, y1
SCENES = [  # (début, fin, fond)
    (0.0, 3.5, YELLOW),
    (3.5, 7.5, NAVY),
    (7.5, 11.5, NAVY),
    (11.5, 15.0, NAVY),
    (15.0, 18.5, YELLOW),
]


def palette_distance(img):
    """Distance de chaque pixel au plus proche segment [couleur A, couleur B] de la charte."""
    p = img.reshape(-1, 3).astype(np.float32)
    best = np.full(p.shape[0], np.inf, dtype=np.float32)
    for i in range(3):
        for j in range(i + 1, 3):
            a, b = PALETTE[i], PALETTE[j]
            ab = b - a
            t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
            d = np.linalg.norm(p - (a + t[:, None] * ab), axis=1)
            best = np.minimum(best, d)
    return best.reshape(img.shape[:2])


def regions(mask, tile=24, min_px=20, min_region=0):
    """Regroupe les pixels signalés en boîtes englobantes (par tuiles connexes)."""
    h, w = mask.shape
    th, tw = (h + tile - 1) // tile, (w + tile - 1) // tile
    pad = np.zeros((th * tile, tw * tile), bool)
    pad[:h, :w] = mask
    counts = pad.reshape(th, tile, tw, tile).sum(axis=(1, 3))
    hot = counts >= min_px
    seen = np.zeros_like(hot)
    boxes = []
    for y, x in zip(*np.nonzero(hot)):
        if seen[y, x]:
            continue
        stack, cells = [(y, x)], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            cells.append((cy, cx))
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < th and 0 <= nx < tw and hot[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        ys, xs = zip(*cells)
        n = int(sum(counts[c] for c in cells))
        if n >= min_region:
            boxes.append((min(xs) * tile, min(ys) * tile, (max(xs) + 1) * tile, (max(ys) + 1) * tile, n))
    return boxes


def check_image(img, bg, tol_palette, tol_bg, label, min_region=0):
    problems, notes = [], []
    dist = palette_distance(img)
    off = dist > tol_palette
    for x0, y0, x1, y1, n in regions(off, min_region=min_region):
        notes.append(f"{label} : zone hors charte {n} px dans [{x0},{y0} → {x1},{y1}]")
    outside = np.ones(img.shape[:2], bool)
    x0, y0, x1, y1 = SAFE
    outside[y0:y1, x0:x1] = False
    diff = np.abs(img.astype(np.int16) - np.array(bg, np.int16)).max(axis=2)
    bad = outside & (diff > tol_bg)
    if bad.sum():
        ys, xs = np.nonzero(bad)
        problems.append(f"{label} : {int(bad.sum())} px non-fond hors zone sûre, x {xs.min()}–{xs.max()}, y {ys.min()}–{ys.max()}")
    # fond : moyenne d'un coin, pour vérifier la fidélité de la couleur après encodage
    corner = img[1700:1900, 20:200].reshape(-1, 3).mean(axis=0)
    return problems, notes, corner


def main():
    problems, notes = [], []

    # 1. ffprobe
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(VIDEO)],
        check=True, capture_output=True, text=True).stdout)
    v = [s for s in probe["streams"] if s["codec_type"] == "video"]
    a = [s for s in probe["streams"] if s["codec_type"] == "audio"]
    s = v[0]
    dur = float(probe["format"]["duration"])
    print(f"ffprobe : {s['codec_name']} ({s.get('profile')}), {s['width']}x{s['height']}, "
          f"{s['r_frame_rate']} fps, {s['pix_fmt']}, {dur:.3f} s, {s.get('nb_frames')} images, "
          f"matrice {s.get('color_space')}, pistes audio : {len(a)}, "
          f"{int(probe['format']['size']) / 1e6:.1f} Mo")
    if s["codec_name"] != "h264": problems.append("codec ≠ H.264")
    if (s["width"], s["height"]) != (1080, 1920): problems.append("résolution ≠ 1080x1920")
    if s["r_frame_rate"] != "30/1" or s["avg_frame_rate"] != "30/1": problems.append("cadence ≠ 30 fps")
    if s["pix_fmt"] != "yuv420p": problems.append("pix_fmt ≠ yuv420p")
    if not 15 <= dur <= 20: problems.append(f"durée {dur} hors 15–20 s")
    if a: problems.append("une piste audio est présente")

    # image finale fixe : durée du dernier gel d'image détecté par ffmpeg (freezedetect)
    log = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(VIDEO), "-vf", "freezedetect=n=0.0005:d=0.5", "-map", "0:v", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    starts = [float(l.split("freeze_start: ")[1]) for l in log.splitlines() if "freeze_start" in l]
    hold = dur - starts[-1] if starts else 0.0
    print(f"image finale fixe pendant {hold:.2f} s (à partir de {starts[-1] if starts else '?'} s)")
    if hold < 1.5: problems.append(f"image finale fixe seulement {hold:.2f} s")

    # 2. images de contrôle au milieu de chaque scène
    CONTROLE.mkdir(exist_ok=True)
    for k, (t0, t1, bg) in enumerate(SCENES, 1):
        tm = (t0 + t1) / 2
        out = CONTROLE / f"scene-{k}.png"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-ss", f"{tm:.3f}", "-i", str(VIDEO), "-frames:v", "1",
            "-vf", "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24", str(out)],
            check=True)
        img = np.asarray(Image.open(out).convert("RGB"))
        if img.shape != (1920, 1080, 3): problems.append(f"{out.name} : taille {img.shape}")
        p, n, corner = check_image(img, bg, tol_palette=45, tol_bg=14, min_region=300,
                                   label=f"MP4 scène {k} (t={tm:.2f} s)")
        problems += p
        notes += n
        print(f"scène {k} : {out.relative_to(ROOT)} — fond décodé {tuple(int(round(c)) for c in corner)} (attendu {bg})")

    # 3. mêmes instants en rendu sans perte : contrôle strict des couleurs et des zones sûres
    with tempfile.TemporaryDirectory() as tmp:
        times = [f"{(t0 + t1) / 2:.2f}" for t0, t1, _ in SCENES]
        subprocess.run(["node", str(ROOT / "render.cjs"), "stills", tmp, *times], check=True, capture_output=True)
        for k, ((t0, t1, bg), tm) in enumerate(zip(SCENES, times), 1):
            img = np.asarray(Image.open(Path(tmp) / f"t-{tm}.png").convert("RGB"))
            p, n, _ = check_image(img, bg, tol_palette=12, tol_bg=0, label=f"rendu sans perte scène {k}")
            problems += p
            notes += n

    # 4. couverture (rendu sans perte : contrôle strict)
    img = np.asarray(Image.open(COVER).convert("RGB"))
    if img.shape != (1920, 1080, 3): problems.append(f"cover.png : taille {img.shape}")
    p, n, _ = check_image(img, YELLOW, tol_palette=12, tol_bg=0, label="cover.png")
    problems += p
    notes += n

    print("\nZones hors charte (à justifier) :" if notes else "\nAucune zone hors charte.")
    for x in notes:
        print("  -", x)
    if problems:
        print("\nPROBLÈMES :\n  - " + "\n  - ".join(problems))
        sys.exit(1)
    print("\nOK : format, durée, zones sûres conformes.")


if __name__ == "__main__":
    main()
