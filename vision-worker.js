/* Worker de vision : détection du livret (rapide) ou traitement complet d'une page. */
importScripts('vision-core.js');
importScripts('lib/opencv.js');

const ready = (async () => {
  if (!self.cv || !self.cv.Mat) {
    await new Promise((resolve) => {
      const done = () => resolve();
      if (self.cv && self.cv.Mat) done(); else self.cv.onRuntimeInitialized = done;
    });
  }
})();

function del(...m) { for (const x of m) if (x && !x.isDeleted()) x.delete(); }

async function matToBlob(mat, type, quality) {
  let rgba = mat;
  if (mat.channels() === 1) { rgba = new cv.Mat(); cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA); }
  else if (mat.channels() === 3) { rgba = new cv.Mat(); cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA); }
  const id = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  if (rgba !== mat) rgba.delete();
  const oc = new OffscreenCanvas(id.width, id.height);
  oc.getContext('2d').putImageData(id, 0, 0);
  return oc.convertToBlob({ type, quality });
}

function resized(mat, width) {
  const out = new cv.Mat();
  const h = Math.round(mat.rows * width / mat.cols);
  cv.resize(mat, out, new cv.Size(width, h), 0, 0, cv.INTER_AREA);
  return out;
}

/* Netteté d'une zone fixe (mode cadre verrouillé). */
function sharpIn(img, quad) {
  const src = cv.matFromImageData(img);
  const g = new cv.Mat();
  cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
  const xs = quad.map(p => p[0] * img.width), ys = quad.map(p => p[1] * img.height);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs))), y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
  const roi = g.roi(new cv.Rect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
  const lap = new cv.Mat(), m = new cv.Mat(), s = new cv.Mat();
  cv.Laplacian(roi, lap, cv.CV_64F);
  cv.meanStdDev(lap, m, s);
  const v = s.data64F[0] * s.data64F[0];
  del(src, g, roi, lap, m, s);
  return v;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    await ready;
    if (msg.type === 'ping') { self.postMessage({ type: 'ready' }); return; }

    if (msg.type === 'detect') {
      let det;
      if (msg.fixedQuad) {
        det = { quad: msg.fixedQuad, areaFrac: 0.5, edgeTouch: false, sharp: sharpIn(msg.img, msg.fixedQuad) };
      } else {
        det = Vision.detect(cv, msg.img, { mode: msg.mode || 'page' });
      }
      const fp = det ? Vision.fingerprint(cv, msg.img, det.quad) : null;
      self.postMessage({ type: 'detect', id: msg.id, det, fp, w: msg.img.width, h: msg.img.height });
      return;
    }

    if (msg.type === 'process') {
      const t0 = performance.now();
      const r = Vision.processPage(cv, msg.img, msg.quad, msg.opts || {});
      const colorBlob = await matToBlob(r.color, 'image/jpeg', 0.92);
      const textBlob = msg.opts && msg.opts.textMode === 'nb'
        ? await matToBlob(r.text, 'image/png')
        : await matToBlob(r.text, 'image/jpeg', 0.9);
      const th = resized(r.color, 240);
      const thumbBlob = await matToBlob(th, 'image/jpeg', 0.72);
      th.delete();
      const imageBlobs = [];
      for (const b of r.images) {
        const x = Math.round(b.x * r.color.cols), y = Math.round(b.y * r.color.rows);
        const w = Math.max(1, Math.min(r.color.cols - x, Math.round(b.w * r.color.cols)));
        const h = Math.max(1, Math.min(r.color.rows - y, Math.round(b.h * r.color.rows)));
        const roi = r.color.roi(new cv.Rect(x, y, w, h));
        const crop = roi.clone(); roi.delete();
        imageBlobs.push(await matToBlob(crop, 'image/jpeg', 0.93));
        crop.delete();
      }
      del(r.color, r.text);
      const metrics = Object.assign({}, r.metrics);
      delete metrics.sharpTiles;
      metrics.ms = Math.round(performance.now() - t0);
      self.postMessage({
        type: 'process', id: msg.id, metrics, size: r.size, boxes: r.images,
        colorBlob, textBlob, thumbBlob, imageBlobs
      });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, error: String(err && err.message || err) });
  }
};

self.postMessage({ type: 'loading' });
ready.then(() => self.postMessage({ type: 'ready' }));
