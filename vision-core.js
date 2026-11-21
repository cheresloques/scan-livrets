/* Traitement d'image des pages (OpenCV.js).
   Fonctions pures : elles prennent `cv` et des images {data,width,height} RGBA.
   Utilisé par le worker du navigateur et par les tests Node. */
(function (root) {
  'use strict';

  const V = {};

  function del(...mats) { for (const m of mats) if (m && !m.isDeleted()) m.delete(); }

  /* Ordonne 4 points : haut-gauche, haut-droite, bas-droite, bas-gauche. */
  function orderQuad(pts) {
    const bySum = pts.slice().sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    const tl = bySum[0], br = bySum[3];
    const rest = [bySum[1], bySum[2]];
    rest.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
    const tr = rest[0], bl = rest[1];
    return [tl, tr, br, bl];
  }
  V.orderQuad = orderQuad;

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /* Taille "naturelle" d'un quadrilatère (largeur, hauteur moyennes). */
  V.quadSize = function (q) {
    const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    return { w, h };
  };

  /* Cherche le plus grand quadrilatère convexe dans une liste de contours. */
  function bestQuadFromContours(cv, contours, minArea, W, H) {
    let best = null;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }
      const peri = cv.arcLength(c, true);
      let found = null;
      // plusieurs tolérances : coins arrondis, pages légèrement bombées
      for (const eps of [0.02, 0.03, 0.045]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, eps * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts = [];
          for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
          found = pts;
        }
        approx.delete();
        if (found) break;
      }
      if (!found) {
        // repli : enveloppe convexe puis simplification
        const hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        const hp = cv.arcLength(hull, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, 0.04 * hp, true);
        if (approx.rows === 4) {
          const pts = [];
          for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
          // l'enveloppe ne doit pas trop différer du contour réel
          if (polyArea(pts) < area * 1.25) found = pts;
        }
        del(hull, approx);
      }
      if (found) {
        const q = orderQuad(found);
        const a = polyArea(q);
        // rejette les quadrilatères trop allongés ou dégénérés
        const s = V.quadSize(q);
        const ratio = Math.min(s.w, s.h) / Math.max(s.w, s.h);
        if (ratio > 0.3 && (!best || a > best.area)) best = { quad: q, area: a };
      }
      c.delete();
    }
    return best;
  }

  /* Détection du livret dans une petite image (≈ 480 px de large).
     Renvoie { quad (coordonnées 0..1), areaFrac, edgeTouch, sharp } ou null. */
  V.detect = function (cv, img) {
    const W = img.width, H = img.height;
    const src = cv.matFromImageData(img);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const minArea = W * H * 0.18;
    let best = null;

    // 1) contours des bords (Canny)
    {
      const edges = new cv.Mat();
      cv.Canny(gray, edges, 40, 120);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, k, new cv.Point(-1, -1), 2);
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      best = bestQuadFromContours(cv, contours, minArea, W, H);
      del(edges, k, hier); contours.delete();
    }
    // 2) repli : seuil d'Otsu (page claire sur fond plus sombre)
    if (!best) {
      const th = new cv.Mat();
      cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, k);
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(th, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      best = bestQuadFromContours(cv, contours, minArea, W, H);
      del(th, k, hier); contours.delete();
    }

    let result = null;
    if (best && best.area < W * H * 0.985) {
      const q = best.quad;
      const m = 0.012;
      const edgeTouch = q.some(([x, y]) => x < W * m || y < H * m || x > W * (1 - m) || y > H * (1 - m));
      // netteté rapide à l'intérieur du cadre (pour éviter de déclencher pendant la mise au point)
      const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
      const x1 = Math.min(W, Math.ceil(Math.max(...xs))), y1 = Math.min(H, Math.ceil(Math.max(...ys)));
      const roi = gray.roi(new cv.Rect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
      const lap = new cv.Mat();
      cv.Laplacian(roi, lap, cv.CV_64F);
      const mean = new cv.Mat(), sd = new cv.Mat();
      cv.meanStdDev(lap, mean, sd);
      const sharp = sd.data64F[0] * sd.data64F[0];
      del(roi, lap, mean, sd);
      result = {
        quad: q.map(([x, y]) => [x / W, y / H]),
        areaFrac: best.area / (W * H),
        edgeTouch,
        sharp
      };
    }
    del(src, gray);
    return result;
  };

  /* Petite empreinte (16×16 niveaux de gris) d'une zone, pour repérer un changement de page. */
  V.fingerprint = function (cv, img, quadNorm) {
    const W = img.width, H = img.height;
    const src = cv.matFromImageData(img);
    const q = quadNorm.map(([x, y]) => [x * W, y * H]);
    const out = V._warpMat(cv, src, q, 16, 16);
    const g = new cv.Mat();
    cv.cvtColor(out, g, cv.COLOR_RGBA2GRAY);
    const fp = Array.from(g.data);
    del(src, out, g);
    // normalise la luminosité
    const mean = fp.reduce((a, b) => a + b, 0) / fp.length;
    return fp.map(v => v - mean);
  };

  V.fpDiff = function (a, b) {
    if (!a || !b) return 999;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };

  V._warpMat = function (cv, src, q, outW, outH) {
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...q));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    const M = cv.getPerspectiveTransform(from, to);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    del(from, to, M);
    return out;
  };

  /* Dimensions de sortie : si un format est verrouillé on le réutilise (recadrage identique),
     sinon on part de la taille réelle de la page dans la photo (côté long ≤ maxLong). */
  V.outputSize = function (quadPx, locked, maxLong) {
    if (locked && locked.w && locked.h) return { w: locked.w, h: locked.h };
    const s = V.quadSize(quadPx);
    const scale = Math.min(1, (maxLong || 3000) / Math.max(s.w, s.h));
    return { w: Math.round(s.w * scale / 2) * 2, h: Math.round(s.h * scale / 2) * 2 };
  };

  function percentile(arr, p) {
    const a = Float64Array.from(arr).sort();
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  }

  /* Analyse complète d'une page capturée.
     img : image pleine résolution ; quadNorm : cadre 0..1 ;
     opts : { locked:{w,h}, textMode:'contraste'|'nb', maxLong }
     Renvoie des Mats (couleur, texte) + mesures ; l'appelant encode et libère. */
  V.processPage = function (cv, img, quadNorm, opts) {
    opts = opts || {};
    const W = img.width, H = img.height;
    // léger retrait vers le centre pour ne pas garder le bord de la table
    const cx = quadNorm.reduce((a, p) => a + p[0], 0) / 4, cy = quadNorm.reduce((a, p) => a + p[1], 0) / 4;
    const qpx = quadNorm.map(([x, y]) => [(x + (cx - x) * 0.006) * W, (y + (cy - y) * 0.006) * H]);
    const size = V.outputSize(qpx, opts.locked, opts.maxLong || 3000);
    const src = cv.matFromImageData(img);
    const color = V._warpMat(cv, src, qpx, size.w, size.h);
    src.delete();

    const metrics = {};
    const natural = V.quadSize(qpx);
    metrics.aspect = natural.w / natural.h;
    metrics.width = size.w; metrics.height = size.h;
    metrics.sourcePx = Math.round(Math.max(natural.w, natural.h));

    const gray = new cv.Mat();
    cv.cvtColor(color, gray, cv.COLOR_RGBA2GRAY);

    // --- Netteté : variance du Laplacien par tuiles, on garde les tuiles les plus nettes
    {
      const g = new cv.Mat();
      const sw = 1200, sh = Math.round(size.h * 1200 / size.w);
      cv.resize(gray, g, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
      const lap = new cv.Mat();
      cv.Laplacian(g, lap, cv.CV_32F);
      const nx = 6, ny = 8, vals = [];
      const tw = Math.floor(sw / nx), th = Math.floor(sh / ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const r = lap.roi(new cv.Rect(i * tw, j * th, tw, th));
        const m = new cv.Mat(), s = new cv.Mat();
        cv.meanStdDev(r, m, s);
        vals.push(s.data64F[0] * s.data64F[0]);
        del(r, m, s);
      }
      metrics.sharpness = Math.round(percentile(vals, 0.85));
      metrics.sharpTiles = vals;
      del(g, lap);
    }

    // --- Fond de page estimé (pour l'éclairage et la version texte)
    const small = new cv.Mat();
    const bw = 600, bh = Math.round(size.h * 600 / size.w);
    cv.resize(gray, small, new cv.Size(bw, bh), 0, 0, cv.INTER_AREA);
    const bgSmall = new cv.Mat();
    {
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
      cv.dilate(small, bgSmall, k);
      cv.medianBlur(bgSmall, bgSmall, 21);
      k.delete();
    }
    // --- Illustrations (avant l'éclairage : leurs zones ne comptent pas comme de l'ombre)
    const images = V.findIllustrations(cv, color, small, bgSmall);
    {
      // éclairage : fond par tuiles, en ignorant les tuiles couvertes par une illustration
      const nx = 6, ny = 8, vals = [];
      const tw = Math.floor(bw / nx), th = Math.floor(bh / ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const tx = i / nx, ty = j / ny, tW = 1 / nx, tH = 1 / ny;
        let cover = 0;
        for (const b of images) {
          const ox = Math.max(0, Math.min(tx + tW, b.x + b.w) - Math.max(tx, b.x));
          const oy = Math.max(0, Math.min(ty + tH, b.y + b.h) - Math.max(ty, b.y));
          cover += (ox * oy) / (tW * tH);
        }
        if (cover > 0.25) continue;
        const r = bgSmall.roi(new cv.Rect(i * tw, j * th, tw, th));
        vals.push(cv.mean(r)[0]);
        r.delete();
      }
      if (!vals.length) vals.push(255);
      const mx = percentile(vals, 0.95), mn = percentile(vals, 0.03);
      metrics.lightRatio = +(mn / Math.max(1, mx)).toFixed(2);
      metrics.paper = Math.round(percentile(vals, 0.5));
    }

    // --- Reflets : pixels saturés (blanc brûlé) regroupés en taches
    {
      const rgb = new cv.Mat();
      const sw = 600, sh = bh;
      cv.resize(color, rgb, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
      const ch = new cv.MatVector();
      cv.split(rgb, ch);
      const mn = new cv.Mat();
      cv.min(ch.get(0), ch.get(1), mn);
      const c2 = ch.get(2);
      cv.min(mn, c2, mn);
      const clip = new cv.Mat();
      cv.threshold(mn, clip, 249, 255, cv.THRESH_BINARY);
      const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      cv.morphologyEx(clip, clip, cv.MORPH_OPEN, k);
      const total = cv.countNonZero(clip) / (sw * sh);
      const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
      const n = cv.connectedComponentsWithStats(clip, labels, stats, cents);
      let biggest = 0;
      for (let i = 1; i < n; i++) biggest = Math.max(biggest, stats.intAt(i, cv.CC_STAT_AREA));
      metrics.glareTotal = +total.toFixed(4);
      metrics.glareBlob = +(biggest / (sw * sh)).toFixed(4);
      del(rgb, mn, clip, k, labels, stats, cents);
      for (let i = 0; i < 3; i++) { const m = ch.get(i); m.delete(); }
      ch.delete();
    }

    // --- Version texte : fond aplani + contraste poussé (ou noir et blanc)
    const text = new cv.Mat();
    {
      const bg = new cv.Mat();
      cv.resize(bgSmall, bg, new cv.Size(size.w, size.h), 0, 0, cv.INTER_LINEAR);
      const norm = new cv.Mat();
      cv.divide(gray, bg, norm, 255, -1);
      if (opts.textMode === 'nb') {
        cv.threshold(norm, text, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      } else {
        // étirement : le fond devient blanc, l'encre devient noire, gamma pour épaissir l'encre
        const lut = new cv.Mat(1, 256, cv.CV_8U);
        const lo = 70, hi = 225;
        for (let v = 0; v < 256; v++) {
          let t = (v - lo) / (hi - lo);
          t = Math.min(1, Math.max(0, t));
          lut.data[v] = Math.round(255 * Math.pow(t, 1.6));
        }
        cv.LUT(norm, lut, text);
        lut.delete();
      }
      del(bg, norm);
    }

    // --- Empreinte pour les doublons
    {
      const fp = new cv.Mat();
      cv.resize(small, fp, new cv.Size(16, 16), 0, 0, cv.INTER_AREA);
      const arr = Array.from(fp.data);
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      metrics.fp = arr.map(v => Math.round(v - mean));
      fp.delete();
    }

    del(gray, small, bgSmall);
    return { color, text, metrics, images, size };
  };

  /* Zones d'illustration : couleurs saturées ou demi-teintes en aplats,
     après suppression des traits fins (le texte). Coordonnées 0..1. */
  V.findIllustrations = function (cv, color, small, bgSmall) {
    const sw = small.cols, sh = small.rows;
    const rgb = new cv.Mat();
    cv.resize(color, rgb, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const rgb3 = new cv.Mat();
    cv.cvtColor(rgb, rgb3, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb3, hsv, cv.COLOR_RGB2HSV);
    const ch = new cv.MatVector();
    cv.split(hsv, ch);
    const sat = ch.get(1);
    const satMask = new cv.Mat();
    cv.threshold(sat, satMask, 70, 255, cv.THRESH_BINARY);

    // demi-teintes sur l'image au fond aplani
    const norm = new cv.Mat();
    cv.divide(small, bgSmall, norm, 255, -1);
    const lo = new cv.Mat(), hi = new cv.Mat(), mid = new cv.Mat();
    cv.threshold(norm, lo, 45, 255, cv.THRESH_BINARY);       // pas l'encre noire
    cv.threshold(norm, hi, 210, 255, cv.THRESH_BINARY_INV);   // pas le papier
    cv.bitwise_and(lo, hi, mid);

    const mask = new cv.Mat();
    cv.bitwise_or(satMask, mid, mask);
    // ouverture : retire les traits du texte (même coloré, ex. titres bleus)
    const kOpen = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kOpen);
    const kClose = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(25, 25));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kClose);

    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(mask, labels, stats, cents);
    const out = [];
    for (let i = 1; i < n; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const area = stats.intAt(i, cv.CC_STAT_AREA);
      const frac = (w * h) / (sw * sh);
      const fill = area / (w * h);
      if (frac < 0.015 || w < sw * 0.08 || h < sh * 0.06) continue;
      if (frac > 0.85) continue; // c'est le fond de la page lui-même
      if (fill < 0.35) continue;  // trop clairsemé : probablement du texte ou un cadre
      const pad = 0.008;
      out.push({
        x: Math.max(0, x / sw - pad), y: Math.max(0, y / sh - pad),
        w: Math.min(1, (x + w) / sw + pad) - Math.max(0, x / sw - pad),
        h: Math.min(1, (y + h) / sh + pad) - Math.max(0, y / sh - pad)
      });
    }
    del(rgb, rgb3, hsv, satMask, norm, lo, hi, mid, mask, kOpen, kClose, labels, stats, cents);
    for (let i = 0; i < 3; i++) { const m = ch.get(i); m.delete(); }
    ch.delete();
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return out;
  };

  /* Verdict qualité à partir des mesures.
     ctx : { lockedAspect, medianSharp, prevFp, edgeTouch } */
  V.judge = function (m, ctx) {
    ctx = ctx || {};
    const redo = [], warn = [];
    const sharpRef = ctx.medianSharp || 0;
    if (m.sharpness < 45 || (sharpRef > 0 && m.sharpness < sharpRef * 0.4)) redo.push('floue');
    else if (sharpRef > 0 && m.sharpness < sharpRef * 0.6) warn.push('un peu floue');
    if (ctx.edgeTouch) redo.push('page coupée au bord de la photo');
    if (m.glareTotal > 0.4) redo.push('photo surexposée');
    else if (m.glareBlob > 0.004 || m.glareTotal > 0.012) redo.push('reflet sur la page');
    else if (m.glareBlob > 0.0015) warn.push('petit reflet');
    if (m.lightRatio < 0.35) redo.push('ombre forte sur la page');
    else if (m.lightRatio < 0.6) warn.push('éclairage inégal');
    if (m.paper < 70) redo.push('page trop sombre');
    if (ctx.lockedAspect) {
      const d = Math.abs(m.aspect - ctx.lockedAspect) / ctx.lockedAspect;
      if (d > 0.12) redo.push('cadre mal détecté (format différent)');
      else if (d > 0.06) warn.push('page un peu de travers');
    }
    if (m.sourcePx && m.sourcePx < 1000) warn.push('résolution faible, rapproche-toi');
    if (ctx.prevFp && V.fpDiff(m.fp, ctx.prevFp) < 5) warn.push('identique à la page précédente ?');
    return { status: redo.length ? 'redo' : warn.length ? 'warn' : 'ok', redo, warn };
  };

  /* Verdict OCR (lisibilité du texte). */
  V.judgeOcr = function (conf, words) {
    if (words < 15) return { redo: [], warn: [] };
    if (conf < 55) return { redo: ['texte peu lisible'], warn: [] };
    if (conf < 72) return { redo: [], warn: ['texte moyennement lisible'] };
    return { redo: [], warn: [] };
  };

  if (typeof module === 'object' && module.exports) module.exports = V;
  else root.Vision = V;
})(typeof self !== 'undefined' ? self : this);
