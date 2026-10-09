#!/usr/bin/env node
// Contrôles automatiques sur la page, à l'état final de chaque scène :
//  1. police réellement utilisée par Chromium pour chaque élément (CDP CSS.getPlatformFontsForNode)
//  2. tout le texte dans la zone sûre TikTok (x 110–970, y 190–1500), rien de tronqué
//  3. ordre de lecture : les mots, pris dans l'ordre logique, doivent aller de droite à gauche
//     (les segments latins sont pris en bloc), parenthèses en sens RTL (donc correctement miroitées)
// Usage : node verify-layout.cjs   (code de sortie 1 si un contrôle échoue)
const { openPage } = require('./render.cjs');

const SAFE = { left: 110, right: 970, top: 190, bottom: 1500 };

// [sélecteur, jetons dans l'ordre logique]
const READING = [
  ['#s1 .sticker', ['للطلبة', 'في', 'تونس', '🇹🇳']],
  ['#s1 h1:nth-of-type(1)', ['فما', 'skill', 'في', 'الـ', 'IT']],
  ['#s1 .hl-text', ['ما', 'يحكيوش', 'عليه']],
  ['#s1 h1:nth-of-type(2)', ['في', 'الفاك', '🤫']],
  ['#s2 .lead', ['حتى', 'في', 'أمريكا…']],
  ['#s2 .body', ['عدد', 'المطوّرين', 'اللي', 'عمرهم', 'بين', '22', 'و25', 'سنة', 'واللي', 'خدّامين', 'نقص', 'قريب', '20%', 'من', 'آخر', '2022', 'لسبتمبر', '2025.']],
  ['#s2 .src', ['المصدر:', 'دراسة', 'Canaries in the Coal Mine', 'متاع', 'Stanford Digital Economy Lab', '،', '2025']],
  ['#s3 .card:nth-child(1) .lbl', ['مستعمل', 'نشيط', 'كل', 'شهر', '(', '2024', ')']],
  ['#s3 .card:nth-child(2) .lbl', ['agent IA', 'تعملو', 'في', 'عام', 'واحد', '(', '2025', ')']],
  ['#s3 .src p:nth-child(1)', ['Microsoft', '،', 'Power Platform Community Conference 2024']],
  ['#s3 .src p:nth-child(2)', ['Satya Nadella', '،', 'نتائج', 'Microsoft', 'جويلية', '2025']],
  ['#s4 li:nth-child(1)', ['5', 'سنين', 'خبرة', 'في', 'المجال']],
  ['#s4 li:nth-child(2)', ['نخدم', 'مع', 'شركات', 'فرنسية', 'من', 'تونس']],
  ['#s4 li:nth-child(3)', ['شهايد', 'Microsoft: PL-400', 'و', 'PL-200']],
  ['#s5 .ask', ['تحب', 'تبدا؟']],
  ['#s5 .c1', ['الرابط', 'باش', 'تسجّل', 'وتاخو', 'الـ', 'guide']],
  ['#s5 .c2', ['في', 'أوّل', 'كومنتار']],
  ['#s5 .c3', ['انسخو', 'وحلّو', 'في', 'الـ', 'navigateur']],
];
// Lignes latines : lecture de gauche à droite.
const READING_LTR = [
  ['#s3 .pp', ['Power', 'Platform']],
  ['#s3 .dyn', ['&', 'Dynamics', '365']],
  ['#s4 .role', ['Power', 'Platform', '&', 'Dynamics', '365']],
];

(async () => {
  const { page, video, close } = await openPage();
  const problems = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  // 1. Polices effectivement utilisées
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#stage *' });
  // même ordre (document) que DOM.querySelectorAll
  const texts = await page.evaluate(() => [...document.querySelectorAll('#stage *')].map(e => e.textContent));
  if (texts.length !== nodeIds.length) problems.push('inventaire des nœuds incohérent');
  const families = new Set();
  for (let k = 0; k < nodeIds.length; k++) {
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[k] });
    for (const f of fonts) {
      families.add(f.familyName);
      if (f.familyName === 'Alexandria') continue;
      if (f.familyName !== 'Noto Color Emoji') { problems.push(`police inattendue « ${f.familyName} » pour « ${texts[k].trim().slice(0, 40)} »`); continue; }
      // la police emoji ne doit servir qu'aux emojis (1 glyphe par emoji au maximum)
      const n = (texts[k].match(/\p{Extended_Pictographic}/gu) || []).length + (texts[k].match(/\p{Regional_Indicator}{2}/gu) || []).length;
      if (f.glyphCount > n) problems.push(`police emoji utilisée pour autre chose qu'un emoji : « ${texts[k].trim().slice(0, 40)} »`);
    }
  }
  console.log('Polices utilisées :', [...families].join(', '));

  for (const s of video.scenes) {
    const t = s.end - 0.3; // état final de la scène, avant la transition
    await page.evaluate(tt => window.renderAt(tt), t);

    // 2. Zones sûres + débordements
    const res = await page.evaluate(({ id, SAFE }) => {
      const out = [];
      const scene = document.getElementById(id);
      const walker = document.createTreeWalker(scene, NodeFilter.SHOW_TEXT);
      let box = { l: 1e9, r: -1e9, t: 1e9, b: -1e9 };
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (!n.textContent.trim()) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        for (const rc of r.getClientRects()) {
          box = { l: Math.min(box.l, rc.left), r: Math.max(box.r, rc.right), t: Math.min(box.t, rc.top), b: Math.max(box.b, rc.bottom) };
          if (rc.left < SAFE.left || rc.right > SAFE.right || rc.top < SAFE.top || rc.bottom > SAFE.bottom) {
            out.push(`hors zone sûre : « ${n.textContent.trim().slice(0, 40)} » [${rc.left.toFixed(0)},${rc.top.toFixed(0)} → ${rc.right.toFixed(0)},${rc.bottom.toFixed(0)}]`);
          }
        }
      }
      for (const el of scene.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`débordement : ${el.className}`);
        const r = el.getBoundingClientRect();
        if (el.matches('.logo') && (r.top < SAFE.top || r.left < SAFE.left || r.right > SAFE.right)) out.push('logo hors zone');
      }
      return { out, box };
    }, { id: s.id, SAFE });
    console.log(`${s.id} (t=${t.toFixed(2)}) texte : x ${res.box.l.toFixed(0)}–${res.box.r.toFixed(0)}, y ${res.box.t.toFixed(0)}–${res.box.b.toFixed(0)}`);
    problems.push(...res.out.map(p => `${s.id} ${p}`));
  }

  // 3. Ordre de lecture
  const order = await page.evaluate(({ READING, READING_LTR }) => {
    const out = [];
    function tokenRects(el, tokens) {
      const nodes = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) nodes.push(w.currentNode);
      let full = '', map = [];
      for (const n of nodes) { for (let i = 0; i < n.textContent.length; i++) map.push([n, i]); full += n.textContent; }
      full = full.replace(/ /g, ' ');
      let cur = 0; const rects = [];
      for (const tok of tokens) {
        const i = full.indexOf(tok, cur);
        if (i < 0) { rects.push(null); continue; }
        const r = document.createRange();
        const [sn, so] = map[i]; const [en, eo] = map[i + tok.length - 1];
        r.setStart(sn, so); r.setEnd(en, eo + 1);
        const b = r.getBoundingClientRect();
        rects.push({ tok, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2, h: b.height });
        cur = i + tok.length;
      }
      return rects;
    }
    function check(sel, tokens, rtl) {
      const el = document.querySelector(sel);
      if (!el) { out.push(`${sel} introuvable`); return; }
      const rs = tokenRects(el, tokens);
      rs.forEach((r, k) => { if (!r) out.push(`${sel} : jeton « ${tokens[k]} » introuvable`); });
      for (let k = 1; k < rs.length; k++) {
        const a = rs[k - 1], b = rs[k];
        if (!a || !b) continue;
        const sameLine = Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) / 2;
        if (sameLine) {
          if (rtl ? !(b.cx < a.cx) : !(b.cx > a.cx)) out.push(`${sel} : ordre inversé entre « ${a.tok} » et « ${b.tok} »`);
        } else if (!(b.cy > a.cy)) out.push(`${sel} : retour à la ligne incohérent entre « ${a.tok} » et « ${b.tok} »`);
      }
    }
    READING.forEach(([sel, toks]) => check(sel, toks, true));
    READING_LTR.forEach(([sel, toks]) => check(sel, toks, false));
    return out;
  }, { READING, READING_LTR });
  problems.push(...order);

  await close();
  if (problems.length) { console.log('\nPROBLÈMES :\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log('\nOK : polices, zones sûres et ordre de lecture conformes.');
})().catch(e => { console.error(e); process.exit(1); });
