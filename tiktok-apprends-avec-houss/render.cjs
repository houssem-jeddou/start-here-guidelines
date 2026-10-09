#!/usr/bin/env node
// Rendu image par image de video.html avec Playwright/Chromium, puis assemblage ffmpeg.
//
//   node render.cjs video                 -> tiktok-video-v1.mp4 (1080x1920, 30 fps, H.264 yuv420p, sans audio)
//   node render.cjs still <t> <out.png>   -> une image à l'instant t (secondes)
//   node render.cjs stills <dir> <t>...   -> plusieurs images (dir/t-<t>.png), une seule session navigateur
//   node render.cjs cover                 -> cover.png (scène 1, état complet)
//
// Chaque frame : renderAt(frame / 30) puis capture. Aucune animation temps réel.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = __dirname;
const OUT_VIDEO = path.join(ROOT, 'tiktok-video-v1.mp4');
const OUT_COVER = path.join(ROOT, 'cover.png');
const COVER_T = 3.0;
const TYPES = { '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openPage() {
  const server = await serve();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}/video.html`);
  const fonts = await page.evaluate(() => window.ready);
  if (!fonts.ok || failed.length) {
    console.error('ARRÊT : la police Alexandria (ou une ressource) n\'est pas chargée.', fonts, failed);
    await browser.close(); server.close();
    process.exit(2);
  }
  console.log('Polices OK :', JSON.stringify(fonts));
  const video = await page.evaluate(() => window.VIDEO);
  const close = async () => { await browser.close(); server.close(); };
  return { page, video, close };
}

async function shotAt(page, t) {
  await page.evaluate(tt => window.renderAt(tt), t);
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1920 } });
}

async function renderVideo() {
  const { page, video, close } = await openPage();
  const frames = Math.round(video.DURATION * video.FPS);
  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(video.FPS), '-c:v', 'png', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(video.FPS),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', OUT_VIDEO,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('close', c => c === 0 ? resolve() : reject(new Error('ffmpeg ' + c))));
  for (let f = 0; f < frames; f++) {
    const buf = await shotAt(page, f / video.FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 60 === 0) console.log(`frame ${f}/${frames}`);
  }
  ff.stdin.end();
  await done;
  await close();
  console.log('Vidéo :', OUT_VIDEO);
}

async function renderStill(t, out) {
  const { page, close } = await openPage();
  fs.writeFileSync(out, await shotAt(page, t));
  await close();
  console.log('Image :', out);
}

async function renderStills(dir, times) {
  const { page, close } = await openPage();
  fs.mkdirSync(dir, { recursive: true });
  for (const t of times) fs.writeFileSync(path.join(dir, `t-${t.toFixed(2)}.png`), await shotAt(page, t));
  await close();
}

module.exports = { openPage, shotAt, ROOT };
if (require.main !== module) return;

const [mode, a, b, ...rest] = process.argv.slice(2);
(async () => {
  if (mode === 'video') await renderVideo();
  else if (mode === 'still') await renderStill(parseFloat(a), path.resolve(b));
  else if (mode === 'stills') await renderStills(path.resolve(a), [b, ...rest].map(parseFloat));
  else if (mode === 'cover') await renderStill(COVER_T, OUT_COVER);
  else { console.error('usage: node render.cjs video | still <t> <out.png> | stills <dir> <t>... | cover'); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
