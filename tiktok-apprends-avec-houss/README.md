# TikTok « Apprends avec Houss » — v1

| Livrable | Fichier |
|---|---|
| Vidéo (1080×1920, 30 fps, H.264 yuv420p, 18,5 s, sans audio) | `tiktok-video-v1.mp4` |
| Couverture (scène 1, rendu sans perte) | `cover.png` |
| Images de contrôle (milieu de chaque scène, extraites du MP4) | `controle/scene-1.png` … `scene-5.png` |

## Refaire le rendu

Prérequis : Node 18+, Playwright (Chromium), ffmpeg, Python 3 avec numpy et Pillow.

```bash
node render.cjs video         # tiktok-video-v1.mp4 (renderAt(frame/30) puis capture, image par image)
node render.cjs cover         # cover.png (t = 3,0 s)
node verify-layout.cjs        # polices réellement utilisées, zones sûres, ordre de lecture RTL
python3 verify-video.py       # ffprobe, image finale fixe, images de contrôle, couleurs, zones sûres
```

Le rendu s'arrête (code 2) si la police Alexandria n'est pas chargée.

## Fichiers

- `video.html` : les 5 scènes et la timeline pilotée par `t` (aucune animation temps réel).
- `assets/Alexandria[wght].ttf` : police officielle (Google Fonts, v5.100, OFL), seule police du texte.
- `assets/emoji-tn-shush.ttf` : sous-ensemble de Noto Color Emoji (OFL) limité à 🇹🇳 et 🤫.
- `assets/logo-apprends-avec-houss.svg` : logo d'origine.
- `assets/logo-apprends-avec-houss-charte.svg` : même dessin, recoloré dans les 3 couleurs de la charte
  (le logo d'origine contient des dégradés violet/cyan). Pour revenir au logo d'origine, remplacer
  `logo-apprends-avec-houss-charte.svg` par `logo-apprends-avec-houss.svg` dans `video.html`.
