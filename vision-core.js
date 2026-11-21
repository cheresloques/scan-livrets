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

  /* Tous les quadrilatères convexes plausibles d'une liste de contours. */
  function quadsFromContours(cv, contours, minArea) {
    const out = [];
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
        const s = V.quadSize(q);
        const ratio = Math.min(s.w, s.h) / Math.max(s.w, s.h);
        if (ratio > 0.3) out.push({ quad: q, area: polyArea(q), aspect: s.w / s.h });
      }
      c.delete();
    }
    return out;
  }

  function touchesEdge(q, W, H) {
    const m = 0.012;
    return q.some(([x, y]) => x < W * m || y < H * m || x > W * (1 - m) || y > H * (1 - m));
  }

  /* Choix du cadre : on écarte ce qui touche les bords de la photo (table, set de table…)
     dès qu'un autre candidat existe ; en mode page simple, on veut une page en hauteur. */
  function pickQuad(cv, cands, W, H, mode, gray) {
    let list = cands.filter(c => c.area < W * H * 0.985);
    for (const c of list) c.edge = touchesEdge(c.quad, W, H);
    if (mode === 'page') list = list.filter(c => c.aspect > 0.45 && c.aspect < 1.05);
    if (!list.length) return null;
    const inside = list.filter(c => !c.edge);
    let pool = inside.length ? inside : list;
    // le bord d'une page est du papier clair ; celui d'un set de table ou d'un plateau ne l'est pas.
    // On mesure une bande juste à l'intérieur du cadre (et pas tout l'intérieur : une grande
    // photo sombre sur la page ne doit pas faire préférer l'encadré de texte en dessous).
    if (gray && pool.length > 1) {
      for (const c of pool) {
        const cx = c.quad.reduce((a, p) => a + p[0], 0) / 4, cy = c.quad.reduce((a, p) => a + p[1], 0) / 4;
        const inner = c.quad.map(([x, y]) => [cx + (x - cx) * 0.9, cy + (y - cy) * 0.9]);
        const m = new cv.Mat(H, W, cv.CV_8U, new cv.Scalar(0));
        const po = cv.matFromArray(4, 1, cv.CV_32SC2, [].concat(...c.quad).map(Math.round));
        const pi = cv.matFromArray(4, 1, cv.CV_32SC2, [].concat(...inner).map(Math.round));
        const vo = new cv.MatVector(); vo.push_back(po);
        const vi = new cv.MatVector(); vi.push_back(pi);
        cv.fillPoly(m, vo, new cv.Scalar(255));
        cv.fillPoly(m, vi, new cv.Scalar(0));
        c.light = cv.mean(gray, m)[0];
        del(m, po, pi); vo.delete(); vi.delete();
      }
      const top = Math.max(...pool.map(c => c.light));
      pool = pool.filter(c => c.light >= top * 0.88);
    }
    return pool.reduce((a, b) => (b.area > a.area ? b : a));
  }

  function contoursOf(cv, bin, mode) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
    hier.delete();
    return contours;
  }

  /* Page simple d'un livret ouvert : la reliure n'a pas de bord net.
     On cherche le pli (vallée sombre et étroite, presque verticale), on coupe la zone claire
     le long de ce pli et on garde la plus grande moitié. */
  V.splitAtGutter = function (cv, gray, W, H) {
    const th = new cv.Mat();
    cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(th, th, cv.MORPH_CLOSE, k);
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(th, labels, stats, cents);
    let bi = -1, ba = 0;
    for (let i = 1; i < n; i++) { const a = stats.intAt(i, cv.CC_STAT_AREA); if (a > ba) { ba = a; bi = i; } }
    let result = null;
    if (bi > 0 && ba > W * H * 0.15) {
      const bx = stats.intAt(bi, cv.CC_STAT_LEFT), by = stats.intAt(bi, cv.CC_STAT_TOP);
      const bw = stats.intAt(bi, cv.CC_STAT_WIDTH), bh = stats.intAt(bi, cv.CC_STAT_HEIGHT);
      const lab = labels.data32S, g = gray.data;
      const pts = [];
      const nb = 10, halves = [0.02, 0.04, 0.065].map(f => Math.max(4, Math.round(W * f)));
      for (let j = 0; j < nb; j++) {
        const y0 = Math.round(by + bh * (0.12 + 0.76 * j / nb)), y1 = Math.round(by + bh * (0.12 + 0.76 * (j + 1) / nb));
        const prof = new Float32Array(bw);
        for (let x = 0; x < bw; x++) {
          let sum = 0, cnt = 0;
          for (let y = y0; y < y1; y++) {
            const idx = y * W + bx + x;
            if (lab[idx] === bi) { sum += g[idx]; cnt++; }
          }
          prof[x] = cnt > (y1 - y0) * 0.3 ? sum / cnt : NaN;
        }
        const valid = Array.from(prof).filter(v => !isNaN(v)).sort((a, b) => a - b);
        if (valid.length < bw * 0.5) continue;
        const med = valid[Math.floor(valid.length / 2)];
        let bestX = -1, bestS = 0;
        for (const half of halves) {
          for (let x = Math.round(bw * 0.08) + half; x < Math.round(bw * 0.92) - half; x++) {
            const v = prof[x], l = prof[x - half], r = prof[x + half];
            if (isNaN(v) || isNaN(l) || isNaN(r)) continue;
            const sc = Math.min(l, r) - v; // vallée étroite : plus sombre que ses deux voisins
            if (sc > bestS) { bestS = sc; bestX = x; }
          }
        }
        if (bestX >= 0 && bestS > med * 0.07) pts.push([bx + bestX, (y0 + y1) / 2]);
      }
      if (pts.length >= 4) {
        const xs = pts.map(p => p[0]).sort((a, b) => a - b);
        const mx = xs[Math.floor(xs.length / 2)];
        const keep = pts.filter(p => Math.abs(p[0] - mx) < W * 0.06);
        if (keep.length >= 4) {
          // droite x = a·y + b (le pli peut être penché à cause de la perspective)
          const my = keep.reduce((s, p) => s + p[1], 0) / keep.length;
          const mxx = keep.reduce((s, p) => s + p[0], 0) / keep.length;
          let num = 0, den = 0;
          for (const [x, y] of keep) { num += (y - my) * (x - mxx); den += (y - my) * (y - my); }
          const a = den ? num / den : 0, b = mxx - a * my;
          const xAt = (y) => a * y + b;
          // quelle moitié garder : la plus grande
          let left = 0, right = 0;
          for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
            if (lab[y * W + x] !== bi) continue;
            if (x < xAt(y)) left++; else right++;
          }
          const keepRight = right >= left;
          const mask = new cv.Mat(), ref = new cv.Mat(H, W, cv.CV_32S, new cv.Scalar(bi));
          cv.compare(labels, ref, mask, cv.CMP_EQ);
          ref.delete();
          const cut = keepRight
            ? [0, 0, xAt(0) + 2, 0, xAt(H) + 2, H, 0, H]
            : [xAt(0) - 2, 0, W, 0, W, H, xAt(H) - 2, H];
          const poly = cv.matFromArray(4, 1, cv.CV_32SC2, cut.map(Math.round));
          const pv = new cv.MatVector(); pv.push_back(poly);
          cv.fillPoly(mask, pv, new cv.Scalar(0));
          const contours = contoursOf(cv, mask, cv.RETR_EXTERNAL);
          const cands = quadsFromContours(cv, contours, W * H * 0.1);
          contours.delete();
          const best = pickQuad(cv, cands, W, H, 'page', gray);
          if (best) result = Object.assign(best, { gutter: true });
          del(mask, poly); pv.delete();
        }
      }
    }
    del(th, k, labels, stats, cents);
    return result;
  };

  /* Détection dans une petite image (≈ 480 px de large).
     opts.mode : 'page' (une page à la fois, défaut) ou 'double' (livret entier / double page).
     Renvoie { quad (coordonnées 0..1), areaFrac, edgeTouch, sharp, gutter } ou null. */
  V.detect = function (cv, img, opts) {
    const mode = (opts && opts.mode) || 'page';
    const W = img.width, H = img.height;
    const src = cv.matFromImageData(img);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const minArea = W * H * 0.15;
    let cands = [];

    // 1) contours des bords (Canny) — tous les contours, pas seulement les extérieurs,
    //    pour trouver le livret même posé sur un set de table ou un plateau rectangulaire
    {
      const edges = new cv.Mat();
      cv.Canny(gray, edges, 40, 120);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, k, new cv.Point(-1, -1), 2);
      const contours = contoursOf(cv, edges, cv.RETR_LIST);
      cands = cands.concat(quadsFromContours(cv, contours, minArea));
      del(edges, k); contours.delete();
    }
    // 2) seuil d'Otsu (page claire sur fond plus sombre)
    {
      const th = new cv.Mat();
      cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
      cv.morphologyEx(th, th, cv.MORPH_CLOSE, k);
      const contours = contoursOf(cv, th, cv.RETR_LIST);
      cands = cands.concat(quadsFromContours(cv, contours, minArea));
      del(th, k); contours.delete();
    }
    let best = pickQuad(cv, cands, W, H, mode, gray);
    // 3) page simple sans bord côté reliure : coupe le long du pli
    if (mode === 'page') {
      const g = V.splitAtGutter(cv, gray, W, H);
      if (g) {
        g.edge = touchesEdge(g.quad, W, H);
        if (!best || (best.edge && !g.edge)) best = g;
        else if (!g.edge && g.area > best.area * 1.15) {
          // le cadre trouvé est peut-être un encadré à l'intérieur de la page : on garde la page entière
          const cx = best.quad.reduce((a, p) => a + p[0], 0) / 4, cy = best.quad.reduce((a, p) => a + p[1], 0) / 4;
          const xs = g.quad.map(p => p[0]), ys = g.quad.map(p => p[1]);
          if (cx > Math.min(...xs) && cx < Math.max(...xs) && cy > Math.min(...ys) && cy < Math.max(...ys)) best = g;
        }
      }
    }

    let result = null;
    if (best) {
      const q = best.quad;
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
        edgeTouch: !!best.edge,
        gutter: !!best.gutter,
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
    // marge autour de la page pour ne jamais couper de lettres (un bout de table est sans importance)
    const cx = quadNorm.reduce((a, p) => a + p[0], 0) / 4, cy = quadNorm.reduce((a, p) => a + p[1], 0) / 4;
    const k = 1 + (opts.margin == null ? 0.04 : opts.margin);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const qpx = quadNorm.map(([x, y]) => [clamp(cx + (x - cx) * k) * W, clamp(cy + (y - cy) * k) * H]);
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
    const images = opts.plain ? [] : V.findIllustrations(cv, color, small, bgSmall);
    {
      // éclairage : fond par tuiles, en ignorant les tuiles couvertes par une illustration
      // on ignore la marge ajoutée autour de la page (bout de table)
      const nx = 6, ny = 8, vals = [], mg = 0.05;
      const ox = Math.round(bw * mg), oy = Math.round(bh * mg);
      const tw = Math.floor(bw * (1 - 2 * mg) / nx), th = Math.floor(bh * (1 - 2 * mg) / ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const tW = (1 - 2 * mg) / nx, tH = (1 - 2 * mg) / ny, tx = mg + i * tW, ty = mg + j * tH;
        let cover = 0;
        for (const b of images) {
          const ox = Math.max(0, Math.min(tx + tW, b.x + b.w) - Math.max(tx, b.x));
          const oy = Math.max(0, Math.min(ty + tH, b.y + b.h) - Math.max(ty, b.y));
          cover += (ox * oy) / (tW * tH);
        }
        if (cover > 0.25) continue;
        const r = bgSmall.roi(new cv.Rect(ox + i * tw, oy + j * th, tw, th));
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
    if (ctx.plain) {
      // photo simple : envoyée telle quelle, on signale seulement le flou et les reflets
      if (m.sharpness < 45) warn.push('photo floue');
      if (m.glareBlob > 0.004 || m.glareTotal > 0.012) warn.push('reflet');
      return { status: warn.length ? 'warn' : 'ok', redo, warn };
    }
    const sharpRef = ctx.medianSharp || 0;
    if (m.sharpness < 45 || (sharpRef > 0 && m.sharpness < sharpRef * 0.4)) redo.push('floue');
    else if (sharpRef > 0 && m.sharpness < sharpRef * 0.6) warn.push('un peu floue');
    if (ctx.edgeTouch) redo.push('page coupée au bord de la photo');
    if (m.glareTotal > 0.4) redo.push('photo surexposée');
    else if (m.glareBlob > 0.004 || m.glareTotal > 0.012) redo.push('reflet sur la page');
    else if (m.glareBlob > 0.0015) warn.push('petit reflet');
    // côté reliure, l'ombre du pli est normale (la version lecture la gomme)
    const lr = ctx.gutter ? 0.45 : 0.6;
    if (m.lightRatio < 0.35) redo.push('ombre forte sur la page');
    else if (m.lightRatio < lr) warn.push('éclairage inégal');
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
    // les illustrations et petites étiquettes font baisser la note sans que le texte soit mauvais :
    // on ne demande de refaire que les pages de texte dense vraiment mal lues
    if (words < 25) return { redo: [], warn: [] };
    if (conf < 45 && words >= 120) return { redo: ['texte peu lisible'], warn: [] };
    if (conf < 60) return { redo: [], warn: ['lecture auto difficile, vérifie le texte'] };
    return { redo: [], warn: [] };
  };

  if (typeof module === 'object' && module.exports) module.exports = V;
  else root.Vision = V;
})(typeof self !== 'undefined' ? self : this);
