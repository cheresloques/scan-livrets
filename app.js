/* Scan Livrets — appli de numérisation de livrets et documents papier.
   Caméra en direct → détection du livret → déclenchement auto → contrôle qualité
   → version couleur + version lecture + illustrations → Google Drive. */
'use strict';

const VERSION = '1.8.0';
const CFG = window.SCAN_CONFIG || {};
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(3, '0');

/* ---------- Petits utilitaires de stockage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('sl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sl.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } }
};

const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('scan-livrets', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore('livrets', { keyPath: 'name' });
        const ps = db.createObjectStore('pages', { keyPath: 'id' });
        ps.createIndex('livret', 'livret');
      };
      rq.onsuccess = () => { this.db = rq.result; res(this.db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  put(store, v) { return this.tx(store, 'readwrite', s => { s.put(v); }); },
  del(store, k) { return this.tx(store, 'readwrite', s => { s.delete(k); }); },
  get(store, k) { return this.tx(store, 'readonly', s => this.req(s.get(k))); },
  all(store) { return this.tx(store, 'readonly', s => this.req(s.getAll())); },
  byLivret(name) { return this.tx('pages', 'readonly', s => this.req(s.index('livret').getAll(name))); }
};

/* ---------- État ---------- */
const S = {
  set: Object.assign({
    livret: 'Cycle 3', project: 'Aeon Trespass', pageMode: 'page', livretTurn: 'gauche', textMode: 'contraste', ocr: true, auto: true, delay: 900,
    sound: true, clientId: CFG.clientId || ''
  }, LS.get('settings', {})),
  livret: null,          // fiche du livret courant
  pages: [],             // pages du livret courant
  retakeQueue: [],       // numéros de pages à refaire, dans l'ordre
  frameLock: false,
  lockedQuad: null,
  lastDet: null,
  lastDetAt: 0,
  urls: new Map()        // URLs d'aperçu
};
if (!S.set.clientId && CFG.clientId) S.set.clientId = CFG.clientId;
const saveSettings = () => LS.set('settings', S.set);

function urlFor(key, blob) {
  if (!blob) return '';
  const k = key;
  const cur = S.urls.get(k);
  if (cur && cur.blob === blob) return cur.url;
  if (cur) URL.revokeObjectURL(cur.url);
  const url = URL.createObjectURL(blob);
  S.urls.set(k, { blob, url });
  return url;
}

/* ---------- Workers de vision ---------- */
function makeWorker() {
  const w = new Worker('vision-worker.js');
  const pend = new Map();
  let seq = 0, readyRes;
  const ready = new Promise(r => { readyRes = r; });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { readyRes(); return; }
    if (m.type === 'loading') return;
    const p = pend.get(m.id);
    if (!p) return;
    pend.delete(m.id);
    if (m.type === 'error') p.rej(new Error(m.error)); else p.res(m);
  };
  w.onerror = (e) => console.error('worker', e.message);
  return {
    ready,
    req(msg, transfer) {
      const id = ++seq; msg.id = id;
      return new Promise((res, rej) => { pend.set(id, { res, rej }); w.postMessage(msg, transfer || []); });
    }
  };
}
const detector = makeWorker();
const processor = makeWorker();

/* ---------- Sons et vibrations ---------- */
let audio = null;
function ensureAudio() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { audio = null; } }
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
}
function beep(freq, dur, when = 0, type = 'sine', vol = 0.18) {
  if (!S.set.sound || !audio) return;
  const t = audio.currentTime + when;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  shutter() { beep(1800, 0.05, 0, 'square', 0.08); beep(900, 0.07, 0.05, 'square', 0.06); vib(30); },
  redo() { beep(440, 0.16); beep(330, 0.26, 0.18); vib([180, 80, 180]); },
  warn() { beep(660, 0.12, 0, 'triangle', 0.12); vib(60); },
  ok() { beep(1320, 0.06, 0, 'sine', 0.06); },
  // mode livret : les deux pages de la double page sont bonnes, on peut tourner
  spread() { beep(880, 0.09, 0, 'sine', 0.16); beep(1320, 0.09, 0.11, 'sine', 0.16); beep(1760, 0.16, 0.22, 'sine', 0.16); vib([40, 60, 40]); }
};
function vib(p) { if (S.set.sound && navigator.vibrate) try { navigator.vibrate(p); } catch { /* */ } }
document.addEventListener('pointerdown', ensureAudio, { passive: true });

/* ---------- Caméra ---------- */
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { willReadFrequently: true });
let track = null, wakeLock = null;

let loopStarted = false, cameraStarting = false;
function stopCamera() {
  try { const s = video.srcObject; if (s) s.getTracks().forEach(t => t.stop()); } catch { /* */ }
  video.srcObject = null; track = null;
}
async function startCamera() {
  if (cameraStarting) return;
  cameraStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
    });
    video.srcObject = stream;
    track = stream.getVideoTracks()[0];
    await video.play().catch(() => {});
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (adv.length) track.applyConstraints({ advanced: adv }).catch(() => {});
    $('#torchBtn').hidden = !caps.torch;
    await waitVideo();
    keepAwake();
    hint('Chargement de l\'analyse d\'image…');
    await detector.ready;
    hint('Cadre le livret entier');
    track.addEventListener('ended', () => { if (document.visibilityState === 'visible') restartCamera(); });
    if (!loopStarted) { loopStarted = true; requestAnimationFrame(loop); }
  } catch (err) {
    console.error(err);
    hint(err && err.name === 'NotAllowedError'
      ? 'Autorise la caméra dans les réglages du navigateur, puis recharge'
      : 'Caméra indisponible : ' + (err.message || err), 'stop');
  } finally {
    cameraStarting = false;
  }
}
/* Au retour dans l'appli, Android a souvent coupé la caméra : on la relance */
function restartCamera() {
  stopCamera();
  if (torchOn) { torchOn = false; setToggle($('#torchBtn'), false); }
  hint('Reprise de la caméra…');
  startCamera();
}
let lastFrameAt = performance.now();
(function watchFrames() {
  // compte les vraies images reçues de la caméra (le temps de la vidéo peut avancer sur une image figée)
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const tick = () => { lastFrameAt = performance.now(); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  } else {
    let lastT = -1;
    setInterval(() => { if (video.currentTime !== lastT) { lastT = video.currentTime; lastFrameAt = performance.now(); } }, 300);
  }
})();
setInterval(() => {
  if (document.visibilityState !== 'visible' || cameraStarting || !loopStarted) return;
  const dead = !track || track.readyState !== 'live';
  // caméra coupée, ou plus aucune image depuis 2 s : on relance
  if (dead || performance.now() - lastFrameAt > 2000) { lastFrameAt = performance.now(); restartCamera(); }
}, 700);
function waitVideo() {
  return new Promise(r => {
    const ok = () => video.videoWidth > 0 ? r() : setTimeout(ok, 50);
    ok();
  });
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (!track || track.readyState !== 'live' || track.muted || video.paused) restartCamera();
  else { video.play().catch(() => restartCamera()); lastFrameAt = performance.now(); }
});

/* Correspondance coordonnées vidéo (0..1) → écran (object-fit: cover) */
function mapper() {
  const cw = overlay.clientWidth, ch = overlay.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sc = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
  return ([x, y]) => [ox + x * vw * sc, oy + y * vh * sc];
}
function sizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(overlay.clientWidth * dpr), h = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ---------- Boucle de détection et déclenchement automatique ---------- */
const AC = { armed: true, stableSince: 0, prevQuad: null, prevFp: null, lostSince: 0, captureFp: null, sharpMax: 0, busy: false };
let detBusy = false;

function loop() {
  requestAnimationFrame(loop);
  if (detBusy || document.visibilityState !== 'visible' || video.readyState < 2 || openSheet) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const sw = 480, sh = Math.round(vh * sw / vw);
  if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
  sctx.drawImage(video, 0, 0, sw, sh);
  const img = sctx.getImageData(0, 0, sw, sh);
  detBusy = true;
  detector.req({ type: 'detect', img, mode: S.set.pageMode, fixedQuad: S.frameLock ? S.lockedQuad : null }, [img.data.buffer])
    .then(onDetect).catch(e => console.warn(e)).finally(() => { detBusy = false; });
}

/* Message après la prise : en mode livret on attend le contrôle des deux pages. */
function doneMsg() {
  if (S.set.pageMode !== 'livret') return { t: 'Page prise ✓ — tourne la page', cls: '' };
  return AC.spreadMsg || { t: 'Photo prise : vérification des 2 pages…', cls: '' };
}

function quadMove(a, b) {
  if (!a || !b) return 1;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}
function quadAspectPx(q, w, h) {
  const p = q.map(([x, y]) => [x * w, y * h]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return ((d(p[0], p[1]) + d(p[3], p[2])) / 2) / ((d(p[0], p[3]) + d(p[1], p[2])) / 2);
}

function onDetect(r) {
  const now = performance.now();
  const det = r.det;
  if (!det) {
    S.lastDet = null;
    AC.prevQuad = null; AC.stableSince = 0;
    if (!AC.lostSince) AC.lostSince = now;
    if (!AC.armed && now - AC.lostSince > 350) AC.armed = true;
    draw(null);
    hint(AC.armed ? 'Cadre le livret entier' : doneMsg().t, AC.armed ? '' : doneMsg().cls);
    return;
  }
  AC.lostSince = 0;
  S.lastDet = det; S.lastDetAt = now;

  // changement de page détecté → on réarme
  if (!AC.armed && AC.captureFp && Vision.fpDiff(r.fp, AC.captureFp) > 12) { AC.armed = true; AC.spreadMsg = null; }

  const move = S.frameLock
    ? (AC.prevFp && Vision.fpDiff(r.fp, AC.prevFp) < 4 ? 0 : 1)
    : quadMove(det.quad, AC.prevQuad);
  AC.prevQuad = det.quad; AC.prevFp = r.fp;
  if (move > 0.012 || !AC.stableSince) { AC.stableSince = now; AC.sharpMax = det.sharp; }
  else AC.sharpMax = Math.max(AC.sharpMax, det.sharp);

  const asp = quadAspectPx(det.quad, r.w, r.h);
  // en mode livret, le cadre est une double page : deux fois plus large qu'une page
  const ref = S.livret && S.livret.aspect && S.livret.aspect * (S.set.pageMode === 'livret' ? 2 : 1);
  const aspectOff = ref && !S.frameLock ? Math.abs(asp - ref) / ref > 0.15 : false;

  let state = 'track', msg = '';
  if (!AC.armed) { state = 'done'; msg = doneMsg().t; }
  else if (det.edgeTouch) { state = 'bad'; msg = 'Recule un peu : la page touche le bord'; }
  else if (aspectOff) { state = 'odd'; msg = S.set.pageMode === 'livret' ? 'Format inattendu : cadre bien la double page' : 'Format inattendu : cadre bien une page'; }
  else if (!S.set.auto) { state = 'track'; msg = 'Appuie sur le déclencheur'; }
  else { state = 'steady'; msg = 'Ne bouge plus…'; }

  const elapsed = now - AC.stableSince;
  const progress = Math.min(1, elapsed / S.set.delay);
  draw(det.quad, state, progress);
  hint(msg, state === 'done' ? doneMsg().cls : state === 'bad' ? 'stop' : state === 'steady' ? 'go' : '');

  if (state === 'steady' && elapsed >= S.set.delay && det.sharp >= AC.sharpMax * 0.72 && !AC.busy) {
    capture(det, r.fp);
  }
}

function draw(quad, state, progress) {
  sizeOverlay();
  const cw = overlay.clientWidth, ch = overlay.clientHeight;
  octx.clearRect(0, 0, cw, ch);
  const map = mapper();
  if (S.frameLock && S.lockedQuad) {
    const p = S.lockedQuad.map(map);
    octx.setLineDash([10, 8]); octx.lineWidth = 2; octx.strokeStyle = 'rgba(231,196,138,.9)';
    octx.beginPath(); p.forEach((pt, i) => i ? octx.lineTo(...pt) : octx.moveTo(...pt)); octx.closePath(); octx.stroke();
    octx.setLineDash([]);
  }
  if (!quad || (S.frameLock && state !== 'steady' && state !== 'done')) return;
  const p = quad.map(map);
  const col = { track: '#e7c48a', steady: '#e7c48a', done: '#4fd18b', bad: '#ff6461', odd: '#f2b544' }[state] || '#e7c48a';
  octx.lineJoin = 'round';
  octx.fillStyle = state === 'done' ? 'rgba(79,209,139,.10)' : 'rgba(231,196,138,.08)';
  octx.beginPath(); p.forEach((pt, i) => i ? octx.lineTo(...pt) : octx.moveTo(...pt)); octx.closePath(); octx.fill();
  octx.strokeStyle = col; octx.lineWidth = state === 'done' ? 2 : 2.5; octx.stroke();
  // coins façon viseur
  octx.lineWidth = 5; octx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 3) % 4];
    const seg = (q, t) => [a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t];
    octx.beginPath(); octx.moveTo(...seg(b, 0.12)); octx.lineTo(...a); octx.lineTo(...seg(c, 0.12)); octx.stroke();
  }
  // progression du déclenchement : le contour se remplit
  if (state === 'steady' && progress > 0) {
    const lens = p.map((pt, i) => Math.hypot(p[(i + 1) % 4][0] - pt[0], p[(i + 1) % 4][1] - pt[1]));
    let left = lens.reduce((a, b) => a + b, 0) * progress;
    octx.strokeStyle = '#4fd18b'; octx.lineWidth = 5;
    octx.beginPath(); octx.moveTo(...p[0]);
    for (let i = 0; i < 4 && left > 0; i++) {
      const a = p[i], b = p[(i + 1) % 4], t = Math.min(1, left / lens[i]);
      octx.lineTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      left -= lens[i];
    }
    octx.stroke();
  }
}

let hintTxt = '';
function hint(t, cls) {
  const el = $('#hint');
  if (t !== hintTxt) { el.textContent = t; hintTxt = t; }
  el.className = 'hint' + (cls ? ' ' + cls : '');
}

/* ---------- Capture et traitement ---------- */
function nextNum() {
  return S.pages.reduce((m, p) => Math.max(m, p.num), 0) + 1;
}

function removeForRetake(old) {
  S.pages = S.pages.filter(p => p !== old);
  dismissToast(old.id);
  DB.del('pages', old.id);
}

function newPage(num, quad, edgeTouch, gutter, plain, extra, old) {
  old = old || null;
  const page = Object.assign({
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    livret: S.livret.name, num, created: Date.now(),
    status: 'busy', qRedo: [], qWarn: [], ocrRedo: [], ocrWarn: [], kept: false,
    images: [], ocr: null, edgeTouch, gutter, plain: !!plain,
    upload: { state: 'none', fileIds: {}, prev: old ? Object.assign({}, old.upload.prev || {}, old.upload.fileIds || {}) : null },
    previewUrl: small.toDataURL('image/jpeg', 0.6)
  }, extra || {});
  page.quad = quad;
  S.pages.push(page);
  S.pages.sort((a, b) => a.num - b.num);
  renderStrip(page.id);
  renderCounts();
  return page;
}

function startProcess(page, img, quad, opts, sourceP) {
  sourceP.then(b => { page.source = b; });
  processor.req({ type: 'process', img, quad, opts }, [img.data.buffer])
    .then(async res => { if (!page.source) page.source = await sourceP; return onProcessed(page, res); })
    .catch(err => {
      console.error(err);
      page.status = 'redo'; page.qRedo = ['erreur de traitement'];
      renderStrip(); renderCounts();
    });
}

async function capture(det, fp, plain) {
  AC.busy = true;
  AC.armed = false;
  AC.captureFp = fp || null;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    let quad = det && det.quad, edgeTouch = det ? det.edgeTouch : false;
    const gutter = !!(det && det.gutter && !S.frameLock && !plain);
    if (S.frameLock && S.lockedQuad) { quad = S.lockedQuad; edgeTouch = false; }
    if (plain) { quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; edgeTouch = false; }
    if (!quad) { quad = [[0, 0], [1, 0], [1, 1], [0, 1]]; edgeTouch = false; }

    const fc = document.createElement('canvas');
    fc.width = vw; fc.height = vh;
    const fctx = fc.getContext('2d', { willReadFrequently: true });
    fctx.drawImage(video, 0, 0, vw, vh);
    const img = fctx.getImageData(0, 0, vw, vh);
    // photo d'origine gardée sur le téléphone, pour pouvoir réajuster le cadre à la main
    const sourceP = new Promise(r => fc.toBlob(b => { r(b); fc.width = fc.height = 1; }, 'image/jpeg', 0.9));

    const fl = $('#flash'); fl.hidden = false; fl.style.animation = 'none'; void fl.offsetWidth; fl.style.animation = '';
    setTimeout(() => { fl.hidden = true; }, 280);
    sfx.shutter();

    const opts = {
      locked: plain ? null : (S.livret.size || null),
      textMode: S.set.textMode,
      maxLong: plain ? 4000 : 3000,
      margin: plain ? 0 : 0.04,
      plain: !!plain
    };

    // Livret ouvert, téléphone fixe : une photo = deux pages (gauche puis droite)
    if (S.set.pageMode === 'livret' && !plain) {
      AC.spreadMsg = null;
      const sp = await processor.req({ type: 'split', img: { width: img.width, height: img.height, data: img.data }, quad, turn: S.set.livretTurn || 'gauche' });
      const spread = 's' + Date.now().toString(36);
      // reprise d'une page d'une double page : on remplace les deux pages de cette double page
      let nums = null;
      const target = S.retakeQueue.length ? S.retakeQueue[0] : null;
      const old = target ? S.pages.find(p => p.num === target) : null;
      if (old && old.spread) {
        const pair = S.pages.filter(p => p.spread === old.spread).sort((a, b) => a.num - b.num);
        if (pair.length === 2) {
          nums = pair.map(p => p.num);
          for (const p of pair) removeForRetake(p);
          S.retakeQueue = S.retakeQueue.filter(n => !nums.includes(n));
          renderRetake();
        }
      }
      if (!nums) { const n = nextNum(); nums = [n, n + 1]; }
      const halves = [['g', sp.left], ['d', sp.right]];
      halves.forEach(([side, q], i) => {
        const im = i === 0 ? new ImageData(new Uint8ClampedArray(img.data), img.width, img.height) : img;
        const page = newPage(nums[i], q, edgeTouch, false, false, { spread, side, gutterFound: sp.found, rot: sp.rot || 0 });
        startProcess(page, im, q, opts, sourceP);
      });
      return;
    }

    const target = S.retakeQueue.length ? S.retakeQueue[0] : null;
    const num = target || nextNum();
    const old = target ? S.pages.find(p => p.num === target) : null;
    if (old) {
      removeForRetake(old);
      S.retakeQueue.shift();
      renderRetake();
    }
    const page = newPage(num, quad, edgeTouch, gutter, plain, {}, old);
    startProcess(page, img, quad, opts, sourceP);
  } finally {
    setTimeout(() => { AC.busy = false; }, 400);
  }
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function computeStatus(p) {
  const redo = [...p.qRedo, ...(p.ocrRedo || [])];
  const warn = [...p.qWarn, ...(p.ocrWarn || [])];
  p.status = redo.length ? 'redo' : warn.length ? 'warn' : 'ok';
  return { redo, warn };
}

async function onProcessed(page, res) {
  if (!S.pages.includes(page)) return; // page supprimée entre-temps
  page.color = res.colorBlob;
  page.text = res.textBlob;
  page.textExt = S.set.textMode === 'nb' ? 'png' : 'jpg';
  page.thumb = res.thumbBlob;
  page.metrics = res.metrics;
  page.images = res.boxes.map((box, i) => ({ box, blob: res.imageBlobs[i] }));
  delete page.previewUrl;

  const others = S.pages.filter(p => p !== page && p.metrics && p.status !== 'redo');
  const prev = S.pages.find(p => p.num === page.num - 1 && p.metrics);
  const ctx = {
    lockedAspect: S.livret.aspect || null,
    medianSharp: others.length >= 3 ? median(others.map(p => p.metrics.sharpness)) : 0,
    prevFp: prev ? prev.metrics.fp : null,
    edgeTouch: page.edgeTouch,
    gutter: page.gutter,
    plain: page.plain
  };
  const j = Vision.judge(res.metrics, ctx);
  page.qRedo = j.redo; page.qWarn = j.warn;
  computeStatus(page);

  // le premier bon cadrage fixe le format du livret (recadrage identique ensuite)
  if (!S.livret.size && page.status !== 'redo' && !page.plain) {
    S.livret.size = res.size;
    S.livret.aspect = res.metrics.aspect;
    await DB.put('livrets', S.livret);
  }

  page.ocrPending = !!S.set.ocr && page.status !== 'redo';
  if (!page.ocrPending) markForUpload(page);
  await savePage(page);
  renderStrip(); renderCounts();
  notifyPage(page, !!page.spread);
  if (page.spread) notifySpread(page);
  if (page.ocrPending) queueOcr(page);
  pumpUploads();
}

function notifyPage(p, quiet) {
  const { redo, warn } = computeStatus(p);
  if (p.status === 'redo') {
    if (!quiet) sfx.redo();
    toast({ id: p.id, kind: 'redo', title: `Page ${p.num} à refaire`, text: redo.join(' · '), img: thumbUrl(p), action: 'Refaire', onAction: () => setRetake([p.num]), onOpen: () => openPage(p) });
  } else if (p.status === 'warn' && !p.kept) {
    if (!quiet) sfx.warn();
    toast({ id: p.id, kind: 'warn', title: `Page ${p.num} : à vérifier`, text: warn.join(' · '), img: thumbUrl(p), ttl: 4500, onOpen: () => openPage(p) });
  } else if (!quiet) {
    sfx.ok();
  }
}

/* Mode livret : un seul signal quand les deux pages de la photo sont traitées. */
function notifySpread(page) {
  const pair = S.pages.filter(p => p.spread === page.spread);
  if (pair.length < 2 || pair.some(p => p.status === 'busy')) return;
  if (pair.some(p => p.status === 'redo')) { sfx.redo(); AC.spreadMsg = { t: 'Page à refaire : regarde l\u2019alerte', cls: 'stop' }; }
  else { sfx.spread(); AC.spreadMsg = { t: '2 pages OK ✓ — tourne la page', cls: 'go' }; }
}

function thumbUrl(p) { return p.thumb ? urlFor(p.id + ':t', p.thumb) : (p.previewUrl || ''); }

/* Enregistrement d'une page (sans les champs temporaires) */
function savePage(p) {
  const { previewUrl, ...rec } = p;
  return DB.put('pages', rec);
}

/* ---------- Lecture du texte (OCR) pour vérifier la lisibilité ---------- */
let tess = null, tessLoading = null;
const ocrQueue = [];
let ocrBusy = false;

function loadScript(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some(s => s.src === src)) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Chargement impossible : ' + src));
    document.head.appendChild(s);
  });
}
async function getTess() {
  if (tess) return tess;
  if (!tessLoading) tessLoading = (async () => {
    await loadScript(new URL('lib/tesseract/tesseract.min.js', location.href).href);
    const base = new URL('lib/tesseract/', location.href).href;
    tess = await Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js', corePath: base + 'core', langPath: base + 'lang', gzip: true
    });
    return tess;
  })();
  return tessLoading;
}
function queueOcr(p) { ocrQueue.push(p); pumpOcr(); }
async function pumpOcr() {
  if (ocrBusy) return;
  ocrBusy = true;
  try {
    while (ocrQueue.length) {
      const p = ocrQueue.shift();
      if (!S.pages.includes(p) && !(await DB.get('pages', p.id))) continue;
      try {
        const w = await getTess();
        const r = await w.recognize(p.text);
        const words = (r.data.words || []).filter(x => x.text && x.text.trim().length > 1);
        const conf = Math.round(r.data.confidence || 0);
        p.ocr = { conf, words: words.length, text: r.data.text || '' };
        const j = p.plain ? { redo: [], warn: [] } : Vision.judgeOcr(conf, words.length);
        const before = p.status;
        p.ocrRedo = j.redo; p.ocrWarn = j.warn;
        computeStatus(p);
        if (p.status !== before && (p.status === 'redo' || p.status === 'warn')) notifyPage(p);
      } catch (e) {
        console.warn('OCR', e);
        p.ocr = { conf: null, words: 0, text: '', error: String(e.message || e) };
      }
      p.ocrPending = false;
      markForUpload(p);
      await savePage(p);
      renderStrip(); renderCounts();
      if (openPageId === p.id) renderPageSheet(p);
      pumpUploads();
    }
  } finally { ocrBusy = false; }
}

/* ---------- Google Drive ---------- */
// appli Android (Capacitor) ou page web
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NativePlugins = NATIVE ? { Browser: Capacitor.registerPlugin('Browser'), App: Capacitor.registerPlugin('App') } : {};
const OAUTH_RELAY = 'https://cheresloques.github.io/scan-livrets/oauth.html';
const Drive = {
  scope: 'https://www.googleapis.com/auth/drive',
  client: null,
  tok: LS.get('drive.token', null),
  ok() { return !!(this.tok && Date.now() < this.tok.exp - 60000); },
  async init() {
    if (!S.set.clientId) return false;
    if (this.client && this.client._id === S.set.clientId) return true;
    await loadScript('https://accounts.google.com/gsi/client');
    for (let i = 0; i < 50 && !(window.google && google.accounts && google.accounts.oauth2); i++) await sleep(100);
    this.client = google.accounts.oauth2.initTokenClient({ client_id: S.set.clientId, scope: this.scope, callback: () => {} });
    this.client._id = S.set.clientId;
    return true;
  },
  connect(prompt) {
    if (NATIVE) return this.connectNative(prompt);
    return new Promise(async (res, rej) => {
      try { if (!(await this.init())) return rej(new Error('Identifiant client manquant')); }
      catch (e) { return rej(e); }
      this.client.callback = (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        this.tok = { t: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        LS.set('drive.token', this.tok);
        res();
      };
      this.client.error_callback = (e) => rej(new Error(e && e.type === 'popup_closed' ? 'Connexion annulée' : (e && e.message) || 'Connexion impossible'));
      this.client.requestAccessToken({ prompt: prompt || '' });
    });
  },
  /* Appli Android : la connexion Google se fait dans Chrome (onglet intégré), interdite dans la WebView.
     Google renvoie le jeton à oauth.html (GitHub Pages), qui le repasse à l'appli par scanlivrets://oauth. */
  connectNative(prompt) {
    const { Browser, App } = NativePlugins;
    return new Promise(async (res, rej) => {
      const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      let done = false, sub = null, subClose = null;
      const finish = (fn, arg) => {
        if (done) return; done = true;
        if (sub) sub.remove(); if (subClose) subClose.remove();
        Browser.close().catch(() => {});
        fn(arg);
      };
      sub = await App.addListener('appUrlOpen', ({ url }) => {
        if (!url || !url.startsWith('scanlivrets://oauth')) return;
        const q = new URLSearchParams((url.split('#')[1] || url.split('?')[1] || ''));
        if (q.get('state') !== state) return;
        if (q.get('error')) return finish(rej, new Error(q.get('error') === 'access_denied' ? 'Connexion annulée' : q.get('error')));
        this.tok = { t: q.get('access_token'), exp: Date.now() + (+q.get('expires_in') || 3600) * 1000 };
        LS.set('drive.token', this.tok);
        finish(res);
      });
      // onglet fermé à la main sans finir : on laisse un délai au retour du jeton
      subClose = await Browser.addListener('browserFinished', () => setTimeout(() => finish(rej, new Error('Connexion annulée')), 1500));
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({
        client_id: S.set.clientId, redirect_uri: OAUTH_RELAY, response_type: 'token',
        scope: this.scope, state, include_granted_scopes: 'true',
        ...(prompt ? { prompt } : {})
      }).toString();
      try { await Browser.open({ url: u.href, toolbarColor: '#0a1220' }); }
      catch (e) { finish(rej, e); }
    });
  },
  forget() {
    if (NATIVE && this.tok) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(this.tok.t), { method: 'POST' }).catch(() => {});
    if (this.tok && window.google && google.accounts) try { google.accounts.oauth2.revoke(this.tok.t, () => {}); } catch { /* */ }
    this.tok = null; LS.set('drive.token', null);
  },
  async call(url, opts = {}) {
    if (!this.ok()) { const e = new Error('Connexion Drive expirée'); e.auth = true; throw e; }
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + this.tok.t });
    const r = await fetch(url, opts);
    if (r.status === 401) { this.tok = null; LS.set('drive.token', null); const e = new Error('Connexion Drive expirée'); e.auth = true; throw e; }
    if (!r.ok) { const e = new Error('Drive ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  },
  /* tous les dossiers de ce nom (le plus ancien d'abord) */
  async folderAll(name, parent) {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `name='${esc}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`;
    const r = await this.call('https://www.googleapis.com/drive/v3/files?fields=files(id,createdTime)&orderBy=createdTime&pageSize=20&q=' + encodeURIComponent(q));
    return (r.files || []).map(x => x.id);
  },
  async folder(name, parent) {
    const all = await this.folderAll(name, parent);
    if (all.length) return all[0];
    const c = await this.call('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })
    });
    return c.id;
  },
  async folders(liv) {
    if (liv.folders && liv.folders.root) return liv.folders;
    // un seul calcul à la fois : deux appels simultanés créaient des dossiers en double
    if (this._fl) return this._fl;
    this._fl = this._folders(liv).finally(() => { this._fl = null; });
    return this._fl;
  },
  async _folders(liv) {
    const claude = await this.folder('Claude', 'root');
    const scans = await this.folder('Scans', claude);
    const proj = await this.folder(liv.project || S.set.project || 'Divers', scans);
    const root = await this.folder(liv.name, proj);
    const f = { root };
    for (const [k, n] of [['couleur', 'couleur'], ['lecture', 'lecture'], ['images', 'images'], ['texte', 'texte-lu']]) f[k] = await this.folder(n, root);
    liv.folders = f;
    await DB.put('livrets', liv);
    return f;
  },
  /* Le fichier est-il encore dans ce dossier de travail (ni déplacé, ni à la corbeille) ?
     Une session Claude range les pages traitées ailleurs : il ne faut plus y toucher. */
  async stillIn(id, parent) {
    const allowed = [].concat(parent).filter(Boolean);
    try {
      const r = await this.call(`https://www.googleapis.com/drive/v3/files/${id}?fields=parents,trashed`);
      return !r.trashed && (r.parents || []).some(x => allowed.includes(x));
    } catch (e) { if (e.status === 404) return false; throw e; }
  },
  async upload(name, blob, parent, existingId) {
    // fichier rangé ailleurs entre-temps : on en crée un nouveau dans le dossier de travail
    if (existingId && !(await this.stillIn(existingId, parent))) existingId = null;
    const form = new FormData();
    const meta = existingId ? { name } : { name, parents: [parent] };
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);
    if (existingId) {
      try {
        const r = await this.call(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id`, { method: 'PATCH', body: form });
        return r.id;
      } catch (e) { if (e.status !== 404) throw e; }
      return this.upload(name, blob, parent, null);
    }
    const r = await this.call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
    return r.id;
  },
  async trash(id, parent) {
    // ne jamais mettre à la corbeille un fichier qui a quitté le dossier de travail
    if (parent && !(await this.stillIn(id, parent))) return;
    try {
      await this.call(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
      });
    } catch (e) { if (e.status !== 404) throw e; }
  }
};

function uploadable(p) {
  return p.metrics && !p.ocrPending && (p.status !== 'redo' || p.kept);
}
function markForUpload(p) {
  if (uploadable(p)) p.upload.state = 'pending';
}

let upBusy = false, reportDirty = false;

/* Fichiers Drive à supprimer (page supprimée ou remplacée), gardés même si l'appli est fermée */
const TrashQ = {
  key() { return 'trash.' + (S.livret ? S.livret.name : ''); },
  all() { return LS.get(this.key(), []); },
  add(ids) { const ids2 = ids.filter(Boolean); if (ids2.length) LS.set(this.key(), [...new Set(this.all().concat(ids2))]); },
  drop(id) { LS.set(this.key(), this.all().filter(x => x !== id)); }
};
function pageFileIds(p) {
  const ids = Object.assign({}, (p.upload && p.upload.prev) || {}, (p.upload && p.upload.fileIds) || {});
  return [ids.color, ids.text, ids.ocr, ...(ids.images || []), ...(((p.upload || {}).prev || {}).images || [])].filter(Boolean);
}

async function pumpUploads() {
  renderDrive();
  if (upBusy || !Drive.ok() || !navigator.onLine) return;
  upBusy = true;
  try {
    // 1) ménage en attente
    const tq = TrashQ.all();
    const work = tq.length ? await Drive.folders(S.livret) : null;
    for (const id of tq) {
      // seulement si le fichier est encore dans un dossier de travail (pas rangé dans « traités »)
      try { await Drive.trash(id, [work.couleur, work.lecture, work.images, work.texte]); TrashQ.drop(id); reportDirty = true; }
      catch (e) { if (e.auth) return; console.warn('corbeille', e); break; }
    }
    // 2) envois
    for (;;) {
      const p = S.pages.find(x => x.upload.state === 'pending' && uploadable(x));
      if (!p) break;
      p.upload.state = 'sending'; p.upload.dirty = false; renderDrive(); renderStrip();
      const numAtStart = p.num;
      try {
        await uploadPage(p);
        reportDirty = true;
        // modifiée pendant l'envoi (numéro, illustrations…) : on renvoie
        if (p.num !== numAtStart || p.upload.dirty) p.upload.state = 'pending';
        else p.upload.state = 'done';
      } catch (e) {
        console.warn('upload', e);
        if (e.auth) { p.upload.state = 'pending'; break; }
        if (e.status === 404 && S.livret.folders) { S.livret.folders = null; p.upload.state = 'pending'; continue; }
        p.upload.state = 'error'; p.upload.error = String(e.message || e);
        if (/storageQuotaExceeded|quota/i.test(p.upload.error)) {
          toast({ id: 'quota', kind: 'redo', title: 'Google Drive est plein', text: 'Libère de la place (et vide la corbeille), puis « Synchroniser »' });
          await savePage(p);
          break;
        }
        toast({ id: 'up-' + p.id, kind: 'warn', title: `Envoi de la page ${p.num} impossible`, text: 'Nouvel essai avec « Synchroniser »', ttl: 5000 });
      }
      if (!S.pages.includes(p)) {
        // supprimée pendant l'envoi : ses fichiers partent à la corbeille
        TrashQ.add(pageFileIds(p));
        continue;
      }
      await savePage(p);
      renderStrip();
    }
    if (reportDirty) { await uploadReport().catch(e => console.warn('rapport', e)); reportDirty = false; }
  } finally {
    upBusy = false;
    renderDrive();
  }
}

async function uploadPage(p) {
  const f = await Drive.folders(S.livret);
  const n = pad(p.num);
  const ids = p.upload.fileIds = Object.assign({}, p.upload.fileIds || {});
  const prev = p.upload.prev || {};
  ids.color = await Drive.upload(`p${n}.jpg`, p.color, f.couleur, ids.color || prev.color);
  ids.text = await Drive.upload(`p${n}.${p.textExt || 'jpg'}`, p.text, f.lecture, ids.text || prev.text);
  const oldImages = [...(ids.images || []), ...(prev.images || [])];
  ids.images = [];
  for (const id of oldImages) await Drive.trash(id, f.images);
  for (let i = 0; i < p.images.length; i++) {
    ids.images.push(await Drive.upload(`p${n}-img${i + 1}.jpg`, p.images[i].blob, f.images, null));
  }
  if (p.ocr && p.ocr.text) {
    ids.ocr = await Drive.upload(`p${n}.txt`, new Blob([p.ocr.text], { type: 'text/plain' }), f.texte, ids.ocr || prev.ocr);
  } else if (ids.ocr || prev.ocr) {
    await Drive.trash(ids.ocr || prev.ocr, f.texte); delete ids.ocr;
  }
  delete p.upload.prev;
  p.upload.at = Date.now();
}

/* Synchroniser : le Drive devient le reflet exact des pages gardées dans l'appli */
async function syncDrive() {
  if (!Drive.ok()) { await driveConnect(); if (!Drive.ok()) return; }
  const btn = $('#syncBtn');
  btn.disabled = true; btn.textContent = 'Synchronisation…';
  try {
    while (upBusy) await sleep(300);
    upBusy = true;
    S.livret.folders = null; // revérifie les dossiers
    const f = await Drive.folders(S.livret);
    const expected = new Map(); // id -> nom attendu
    for (const p of S.pages) {
      if (!uploadable(p)) continue;
      const ids = p.upload.fileIds || {}, n = pad(p.num);
      if (ids.color) expected.set(ids.color, { p, name: `p${n}.jpg` });
      if (ids.text) expected.set(ids.text, { p, name: `p${n}.${p.textExt || 'jpg'}` });
      if (ids.ocr) expected.set(ids.ocr, { p, name: `p${n}.txt` });
      (ids.images || []).forEach((id, i) => expected.set(id, { p, name: `p${n}-img${i + 1}.jpg` }));
    }
    const seen = new Set();
    let trashed = 0;
    // chaque dossier de travail, y compris d'éventuels doublons (même nom) : on regroupe tout dans le plus ancien
    for (const [k, n] of [['couleur', 'couleur'], ['lecture', 'lecture'], ['images', 'images'], ['texte', 'texte-lu']]) {
      const all = await Drive.folderAll(n, f.root);
      const main = f[k];
      for (const folder of [main, ...all.filter(x => x !== main)]) {
        let token = '';
        do {
          const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
          const r = await Drive.call(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${token ? '&pageToken=' + token : ''}`);
          for (const file of r.files || []) {
            const exp = expected.get(file.id);
            if (!exp) { await Drive.trash(file.id); trashed++; continue; }
            if (folder !== main) {
              await Drive.call(`https://www.googleapis.com/drive/v3/files/${file.id}?addParents=${main}&removeParents=${folder}&fields=id`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}'
              });
            }
            seen.add(file.id);
            if (exp.name !== file.name) exp.p.upload.state = 'pending';
          }
          token = r.nextPageToken || '';
        } while (token);
        if (folder !== main) await Drive.trash(folder); // doublon vidé
      }
    }
    LS.set(TrashQ.key(), []); // tout ce qui est en trop vient d'être retiré
    // pages traitées : une session Claude a mis leurs fichiers à la corbeille ou les a déplacés hors des
    // dossiers de travail (ex. « <livret> - traités ») → on les retire du téléphone, sans toucher au Drive
    const work = new Set([f.couleur, f.lecture, f.images, f.texte]);
    const processed = [];
    for (const p of S.pages) {
      const ids = p.upload.fileIds || {};
      if (p.upload.state !== 'done') continue;
      const check = [ids.color, ids.text].filter(id => id && !seen.has(id));
      let gone = false;
      for (const id of check) {
        try {
          const m = await Drive.call(`https://www.googleapis.com/drive/v3/files/${id}?fields=trashed,parents`);
          if (m.trashed || !(m.parents || []).some(x => work.has(x))) gone = true;
        } catch (e) { if (e.status === 404) gone = true; else throw e; }
        if (gone) break;
      }
      if (gone) processed.push(p);
    }
    if (processed.length) await removeLocal(processed);
    let resend = 0;
    for (const p of S.pages) {
      if (!uploadable(p)) continue;
      const ids = p.upload.fileIds || {};
      const missing = [ids.color, ids.text, ...(ids.images || [])].some(id => !id || !seen.has(id)) || (p.ocr && p.ocr.text && !(ids.ocr && seen.has(ids.ocr)));
      if (missing || p.upload.state !== 'done') {
        if (missing) { ids.color = seen.has(ids.color) ? ids.color : null; ids.text = seen.has(ids.text) ? ids.text : null; ids.ocr = seen.has(ids.ocr) ? ids.ocr : null; ids.images = (ids.images || []).filter(id => seen.has(id)); }
        p.upload.state = 'pending'; resend++;
        await savePage(p);
      }
    }
    reportDirty = true;
    upBusy = false;
    const parts = [];
    if (processed.length) parts.push(`${processed.length} page${processed.length > 1 ? 's' : ''} traitée${processed.length > 1 ? 's' : ''} retirée${processed.length > 1 ? 's' : ''} du téléphone`);
    parts.push(`${trashed} fichier${trashed > 1 ? 's' : ''} en trop retiré${trashed > 1 ? 's' : ''}`);
    parts.push(`${resend} page${resend > 1 ? 's' : ''} à renvoyer`);
    toast({ id: 'sync', kind: 'ok', title: 'Synchronisation faite', text: parts.join(', '), ttl: 6000 });
    await pumpUploads();
  } catch (e) {
    console.warn('sync', e);
    toast({ id: 'sync', kind: 'redo', title: 'Synchronisation impossible', text: e.message, ttl: 6000 });
  } finally {
    upBusy = false;
    btn.disabled = false; btn.textContent = 'Synchroniser avec Drive';
    renderDrive(); renderStrip();
  }
}

async function uploadReport() {
  const f = await Drive.folders(S.livret);
  const rep = {
    livret: S.livret.name,
    misAJour: new Date().toISOString(),
    formatPage: S.livret.size,
    dossiers: { couleur: 'pages photographiées, redressées', lecture: 'version contrastée pour lire le texte', images: 'illustrations découpées', 'texte-lu': 'texte reconnu automatiquement (brouillon)' },
    pages: S.pages.map(p => ({
      page: p.num, statut: p.status, gardeeMalgreAlerte: p.kept || undefined,
      aRefaire: p.qRedo.concat(p.ocrRedo || []), aVerifier: p.qWarn.concat(p.ocrWarn || []),
      illustrations: p.images.length, lisibiliteOCR: p.ocr ? p.ocr.conf : null,
      envoyee: p.upload.state === 'done'
    }))
  };
  const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
  S.livret.reportId = await Drive.upload('rapport.json', blob, f.root, S.livret.reportId);
  await DB.put('livrets', S.livret);
}

window.addEventListener('online', pumpUploads);

/* ---------- Alertes ---------- */
const toasts = new Map();
function toast(o) {
  dismissToast(o.id);
  const el = document.createElement('div');
  el.className = 'toast ' + (o.kind || '');
  el.innerHTML = `${o.img ? '<img alt="">' : ''}<div class="tx"><b></b><span></span></div>`;
  if (o.img) el.querySelector('img').src = o.img;
  el.querySelector('b').textContent = o.title;
  el.querySelector('span').textContent = o.text || '';
  if (o.action) {
    const b = document.createElement('button');
    b.textContent = o.action;
    b.onclick = (e) => { e.stopPropagation(); dismissToast(o.id); o.onAction(); };
    el.appendChild(b);
  }
  const x = document.createElement('button');
  x.className = 'dismiss'; x.textContent = '×'; x.setAttribute('aria-label', 'Fermer');
  x.onclick = (e) => { e.stopPropagation(); dismissToast(o.id); };
  el.appendChild(x);
  if (o.onOpen) el.querySelector('.tx').onclick = () => o.onOpen();
  $('#toasts').prepend(el);
  toasts.set(o.id, el);
  const list = [...$('#toasts').children];
  list.slice(3).forEach(n => n.remove());
  if (o.ttl) setTimeout(() => { if (toasts.get(o.id) === el) dismissToast(o.id); }, o.ttl);
}
function dismissToast(id) {
  const el = toasts.get(id);
  if (el) { el.remove(); toasts.delete(id); }
}

/* ---------- Pages à refaire ---------- */
function setRetake(nums) {
  S.retakeQueue = [...new Set(nums)].sort((a, b) => a - b);
  closeSheets();
  AC.armed = true;
  renderRetake(); renderStrip();
}
function renderRetake() {
  const el = $('#retakeBanner');
  if (!S.retakeQueue.length) { el.hidden = true; renderStrip(); return; }
  const rest = S.retakeQueue.length - 1;
  el.innerHTML = '<span></span><button>Annuler</button>';
  el.querySelector('span').textContent = `Refais la page ${S.retakeQueue[0]}` + (rest ? ` (puis ${rest} autre${rest > 1 ? 's' : ''})` : '');
  el.querySelector('button').onclick = () => { S.retakeQueue = []; renderRetake(); };
  el.hidden = false;
}

/* ---------- Bande de pages et compteurs ---------- */
function thumbEl(p) {
  const b = document.createElement('button');
  const busy = p.status === 'busy' || p.ocrPending || p.upload.state === 'sending';
  b.className = 'thumb ' + (p.status === 'busy' ? '' : (p.kept && p.status === 'redo' ? 'warn' : p.status)) + (busy ? ' busy' : '') +
    (S.retakeQueue[0] === p.num ? ' target' : '');
  b.innerHTML = `<img alt=""><span class="n">${p.num}</span>${p.upload.state === 'done' ? '<i class="up"></i>' : ''}`;
  b.querySelector('img').src = thumbUrl(p);
  b.setAttribute('aria-label', `Page ${p.num}`);
  b.onclick = () => openPage(p);
  return b;
}
function renderStrip(scrollToId) {
  const strip = $('#strip');
  strip.replaceChildren(...S.pages.map(thumbEl));
  if (scrollToId) {
    const idx = S.pages.findIndex(p => p.id === scrollToId);
    const el = strip.children[idx];
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  if (openSheet === 'menu') renderMenu();
}
function renderCounts() {
  const total = S.pages.length;
  const redo = S.pages.filter(p => p.status === 'redo' && !p.kept).length;
  const warn = S.pages.filter(p => p.status === 'warn' && !p.kept).length;
  const busy = S.pages.filter(p => p.status === 'busy' || p.ocrPending).length;
  const parts = [`<span class="pill">${total} page${total > 1 ? 's' : ''}</span>`];
  if (redo) parts.push(`<span class="pill redo">${redo} à refaire</span>`);
  if (warn) parts.push(`<span class="pill warn">${warn} à vérifier</span>`);
  if (busy) parts.push(`<span class="pill busy">analyse ${busy}</span>`);
  $('#counts').innerHTML = parts.join('');
}
function renderDrive() {
  const btn = $('#driveBtn'), lbl = $('#driveLabel');
  const pending = S.pages.filter(p => (p.upload.state === 'pending' || p.upload.state === 'error') && uploadable(p)).length;
  const sending = S.pages.some(p => p.upload.state === 'sending');
  const done = S.pages.filter(p => p.upload.state === 'done').length;
  btn.classList.remove('ok', 'pending', 'err');
  if (!S.set.clientId) { lbl.textContent = 'Drive'; }
  else if (!Drive.ok()) { btn.classList.add(pending ? 'err' : 'pending'); lbl.textContent = pending ? `${pending} en attente` : 'Connecter'; }
  else if (sending) { btn.classList.add('pending'); lbl.textContent = `Envoi… ${done}/${done + pending + 1}`; }
  else if (pending) { btn.classList.add('pending'); lbl.textContent = `${pending} en attente`; }
  else { btn.classList.add('ok'); lbl.textContent = `✓ ${done}`; }
}

/* ---------- Fiches ---------- */
let openSheet = null, openPageId = null, pageView = 'color';
function showSheet(id) {
  closeSheets(true);
  $('#backdrop').hidden = false;
  $(id).hidden = false;
  openSheet = id === '#menuSheet' ? 'menu' : id === '#adjustSheet' ? 'adjust' : 'page';
}
function closeSheets(silent) {
  $('#pageSheet').hidden = true; $('#menuSheet').hidden = true; $('#adjustSheet').hidden = true; $('#backdrop').hidden = true;
  openSheet = null; openPageId = null;
  if (!silent) { AC.stableSince = 0; }
}
$('#backdrop').onclick = () => closeSheets();
document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => closeSheets(); });

function openPage(p) {
  showSheet('#pageSheet');
  openPageId = p.id;
  pageView = 'color';
  renderPageSheet(p);
}
function renderPageSheet(p) {
  $('#pageNum').value = p.num;
  const { redo, warn } = computeStatus(p);
  const v = $('#pageVerdict');
  v.className = 'verdict ' + (p.status === 'busy' ? '' : p.status);
  const title = p.status === 'busy' ? 'Analyse en cours…'
    : p.status === 'redo' ? (p.kept ? 'Gardée malgré les alertes' : 'À refaire')
    : p.status === 'warn' ? 'Utilisable, à vérifier' : 'Bonne page';
  const items = [...redo, ...warn];
  if (p.ocrPending) items.push('lecture du texte en cours…');
  if (p.ocr && p.ocr.conf != null) items.push(`texte reconnu à ${p.ocr.conf} %`);
  items.push(p.upload.state === 'done' ? 'envoyée sur Drive' : p.upload.state === 'error' ? 'envoi en échec' : uploadable(p) ? 'en attente d\'envoi' : 'pas envoyée');
  v.innerHTML = '<b></b><ul></ul>';
  v.querySelector('b').textContent = title;
  v.querySelector('ul').replaceChildren(...items.map(t => { const li = document.createElement('li'); li.textContent = t; return li; }));

  $('#viewColor').classList.toggle('on', pageView === 'color');
  $('#viewText').classList.toggle('on', pageView === 'text');
  const img = $('#pageImg');
  const src = pageView === 'color' ? (p.color ? urlFor(p.id + ':c', p.color) : thumbUrl(p)) : (p.text ? urlFor(p.id + ':x', p.text) : thumbUrl(p));
  if (img.src !== src) img.src = src;
  renderBoxes(p);
  $('#imgList').replaceChildren(...p.images.map((im, i) => {
    const el = document.createElement('img');
    el.src = urlFor(p.id + ':i' + i, im.blob); el.alt = `Illustration ${i + 1}`;
    return el;
  }));
  $('#keepOne').hidden = p.status !== 'redo' || p.kept;
  // les photos simples d'avant la 1.6 n'ont pas de photo d'origine : leur version couleur est l'image entière
  if (!p.source && p.plain && p.color) p.source = p.color;
  $('#adjustOne').hidden = !p.source;
  $('#plainNote').hidden = !p.plain;
  const m = Object.assign({}, p.metrics || {}); delete m.fp;
  $('#pageMetrics').textContent = JSON.stringify(m, null, 1);
}

let selBox = -1;
function renderBoxes(p) {
  const layer = $('#boxLayer');
  layer.replaceChildren(...p.images.map((im, i) => {
    const d = document.createElement('div');
    d.className = 'box' + (i === selBox ? ' sel' : '');
    Object.assign(d.style, { left: im.box.x * 100 + '%', top: im.box.y * 100 + '%', width: im.box.w * 100 + '%', height: im.box.h * 100 + '%' });
    d.dataset.i = i;
    if (i === selBox) {
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '×'; del.setAttribute('aria-label', 'Retirer cette illustration');
      del.onpointerdown = (e) => e.stopPropagation();
      del.onclick = async (e) => {
        e.stopPropagation();
        p.images.splice(i, 1); selBox = -1;
        changed(p);
      };
      d.appendChild(del);
    }
    return d;
  }));
}
async function changed(p) {
  if (p.upload.state === 'done' || p.upload.state === 'error') p.upload.state = 'pending';
  if (p.upload.state === 'sending') p.upload.dirty = true;
  await savePage(p);
  renderPageSheet(p); renderStrip(); pumpUploads();
}

/* Ajout d'une illustration en faisant glisser le doigt */
(function boxDrawing() {
  const stage = $('#pageStage');
  let start = null, draft = null;
  const rel = (e) => {
    const r = $('#pageImg').getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  stage.addEventListener('pointerdown', (e) => {
    const p = S.pages.find(x => x.id === openPageId);
    if (!p || !p.color) return;
    const hit = e.target.closest('.box');
    if (hit) { selBox = selBox === +hit.dataset.i ? -1 : +hit.dataset.i; renderBoxes(p); return; }
    selBox = -1;
    start = rel(e);
    draft = document.createElement('div'); draft.className = 'box draft';
    $('#boxLayer').appendChild(draft);
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!start) return;
    const [x, y] = rel(e);
    Object.assign(draft.style, {
      left: Math.min(x, start[0]) * 100 + '%', top: Math.min(y, start[1]) * 100 + '%',
      width: Math.abs(x - start[0]) * 100 + '%', height: Math.abs(y - start[1]) * 100 + '%'
    });
  });
  const end = async (e) => {
    if (!start) return;
    const [x, y] = rel(e);
    const box = { x: Math.min(x, start[0]), y: Math.min(y, start[1]), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) };
    start = null; draft && draft.remove(); draft = null;
    const p = S.pages.find(q => q.id === openPageId);
    if (!p) return;
    if (box.w < 0.04 || box.h < 0.03) { renderBoxes(p); return; }
    const blob = await cropBlob(p.color, box);
    p.images.push({ box, blob });
    p.images.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    changed(p);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { start = null; draft && draft.remove(); draft = null; });
})();

/* ---------- Ajuster le cadre à la main ---------- */
const Adj = { page: null, q: null, drag: -1 };
function openAdjust(p) {
  Adj.page = p;
  const isFull = p.plain || !p.quad;
  Adj.q = (isFull ? [[0.1, 0.08], [0.9, 0.08], [0.9, 0.92], [0.1, 0.92]] : p.quad).map(c => c.slice());
  showSheet('#adjustSheet');
  openPageId = p.id;
  const img = $('#adjImg');
  img.onload = () => drawAdjust();
  img.src = urlFor(p.id + ':s', p.source);
  if (img.complete) drawAdjust();
}
function drawAdjust() {
  const img = $('#adjImg');
  const w = img.clientWidth, h = img.clientHeight;
  if (!w) return;
  const svg = $('#adjSvg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  $('#adjPoly').setAttribute('points', Adj.q.map(([x, y]) => `${x * w},${y * h}`).join(' '));
  document.querySelectorAll('#adjStage .h').forEach((el) => {
    const [x, y] = Adj.q[+el.dataset.k];
    el.style.left = x * w + 'px'; el.style.top = y * h + 'px';
    el.classList.toggle('on', Adj.drag === +el.dataset.k);
  });
}
(function adjustDrag() {
  const stage = $('#adjStage');
  const rel = (e) => {
    const r = $('#adjImg').getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!Adj.page) return;
    const [x, y] = rel(e);
    const r = $('#adjImg').getBoundingClientRect();
    // le coin le plus proche du doigt (jusqu'à ~50 px)
    let best = -1, bd = 1e9;
    Adj.q.forEach(([qx, qy], i) => { const d = Math.hypot((qx - x) * r.width, (qy - y) * r.height); if (d < bd) { bd = d; best = i; } });
    if (bd > 60) return;
    Adj.drag = best; Adj.off = [Adj.q[best][0] - x, Adj.q[best][1] - y];
    stage.setPointerCapture(e.pointerId);
    drawAdjust();
  });
  stage.addEventListener('pointermove', (e) => {
    if (Adj.drag < 0) return;
    const [x, y] = rel(e);
    Adj.q[Adj.drag] = [Math.min(1, Math.max(0, x + Adj.off[0])), Math.min(1, Math.max(0, y + Adj.off[1]))];
    drawAdjust();
  });
  const end = () => { Adj.drag = -1; drawAdjust(); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (openSheet === 'adjust') drawAdjust(); });
})();
$('#adjustOne').onclick = () => { const p = S.pages.find(x => x.id === openPageId); if (p && p.source) openAdjust(p); };
$('#adjReset').onclick = () => { Adj.q = [[0, 0], [1, 0], [1, 1], [0, 1]]; drawAdjust(); };
$('#adjOk').onclick = async () => {
  const p = Adj.page; if (!p || !S.pages.includes(p)) return;
  let quad = Vision.orderQuad(Adj.q.map(c => c.slice()));
  // page issue d'une double page couchée : on garde le même sens de redressement
  for (let i = 0; i < (p.rot || 0); i++) quad = [quad[3], quad[0], quad[1], quad[2]];
  closeSheets();
  p.quad = quad; p.plain = false; p.edgeTouch = false; p.gutter = false;
  p.status = 'busy'; p.ocrPending = false; p.kept = false;
  if (p.upload.state === 'sending') p.upload.dirty = true;
  renderStrip(); renderCounts();
  try {
    const bmp = await createImageBitmap(p.source);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height);
    c.width = c.height = 1;
    const opts = { locked: S.livret.size || null, textMode: S.set.textMode, maxLong: 3000, margin: 0.01 };
    const res = await processor.req({ type: 'process', img, quad, opts }, [img.data.buffer]);
    await onProcessed(p, res);
    toast({ id: 'adj', kind: 'ok', title: `Page ${p.num} recadrée`, text: 'Nouvelle version envoyée à la place de l\'ancienne', ttl: 3000 });
  } catch (err) {
    console.error(err);
    p.status = 'redo'; p.qRedo = ['erreur de recadrage'];
    renderStrip(); renderCounts();
  }
};

async function cropBlob(blob, box) {
  const bmp = await createImageBitmap(blob);
  const x = Math.round(box.x * bmp.width), y = Math.round(box.y * bmp.height);
  const w = Math.round(box.w * bmp.width), h = Math.round(box.h * bmp.height);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close && bmp.close();
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.93));
}

$('#viewColor').onclick = () => { pageView = 'color'; const p = S.pages.find(x => x.id === openPageId); p && renderPageSheet(p); };
$('#viewText').onclick = () => { pageView = 'text'; const p = S.pages.find(x => x.id === openPageId); p && renderPageSheet(p); };
$('#retakeOne').onclick = () => { const p = S.pages.find(x => x.id === openPageId); if (p) setRetake([p.num]); };
$('#keepOne').onclick = async () => {
  const p = S.pages.find(x => x.id === openPageId); if (!p) return;
  p.kept = true; dismissToast(p.id); markForUpload(p);
  await savePage(p); renderPageSheet(p); renderStrip(); renderCounts(); pumpUploads();
};
let deleteArmed = null;
$('#deleteOne').onclick = async () => {
  const p = S.pages.find(x => x.id === openPageId); if (!p) return;
  const btn = $('#deleteOne');
  if (deleteArmed !== p.id) { deleteArmed = p.id; btn.textContent = 'Confirmer la suppression'; setTimeout(() => { deleteArmed = null; btn.textContent = 'Supprimer'; }, 3000); return; }
  deleteArmed = null; btn.textContent = 'Supprimer';
  await deletePages([p]);
  closeSheets();
};
/* Retire des pages du téléphone sans toucher à leurs fichiers Drive (pages traitées) */
async function removeLocal(list) {
  for (const p of list) {
    S.pages = S.pages.filter(x => x !== p);
    dismissToast(p.id);
    S.retakeQueue = S.retakeQueue.filter(n => n !== p.num);
    await DB.del('pages', p.id);
  }
  renderRetake(); renderStrip(); renderCounts(); renderDrive();
}
/* Supprime des pages de l'appli ; leurs fichiers Drive partent à la corbeille */
async function deletePages(list) {
  for (const p of list) {
    S.pages = S.pages.filter(x => x !== p);
    dismissToast(p.id);
    S.retakeQueue = S.retakeQueue.filter(n => n !== p.num);
    await DB.del('pages', p.id);
    if (p.upload.state !== 'sending') { TrashQ.add(pageFileIds(p)); reportDirty = true; }
  }
  renderRetake(); renderStrip(); renderCounts(); renderDrive();
  pumpUploads();
}
$('#pageNum').onchange = async (e) => {
  const p = S.pages.find(x => x.id === openPageId); if (!p) return;
  const n = parseInt(e.target.value, 10);
  if (!n || n < 1) { e.target.value = p.num; return; }
  if (S.pages.some(x => x !== p && x.num === n)) { toast({ id: 'num', kind: 'warn', title: `La page ${n} existe déjà`, text: 'Supprime-la ou choisis un autre numéro', ttl: 3500 }); e.target.value = p.num; return; }
  p.num = n;
  S.pages.sort((a, b) => a.num - b.num);
  changed(p);
};

/* ---------- Menu livret et réglages ---------- */
function renderMenu() {
  const total = S.pages.length;
  const by = (f) => S.pages.filter(f).length;
  const sum = $('#summary');
  sum.innerHTML = '';
  const add = (t, c) => { const s = document.createElement('span'); s.className = 'pill ' + (c || ''); s.textContent = t; sum.appendChild(s); };
  add(`${total} page${total > 1 ? 's' : ''}`);
  add(`${by(p => p.status === 'ok' || p.kept)} bonnes`);
  const r = by(p => p.status === 'redo' && !p.kept); if (r) add(`${r} à refaire`, 'redo');
  const w = by(p => p.status === 'warn'); if (w) add(`${w} à vérifier`, 'warn');
  add(`${by(p => p.upload.state === 'done')} sur Drive`);
  if (S.livret.size) add(`format ${S.livret.size.w}×${S.livret.size.h}`);
  $('#retakeAll').disabled = !r;
  for (const id of [...Sel.ids]) if (!S.pages.some(p => p.id === id)) Sel.ids.delete(id);
  const grid = $('#grid');
  grid.classList.toggle('selecting', Sel.on);
  grid.replaceChildren(...S.pages.map(p => {
    const el = thumbEl(p);
    if (Sel.on) {
      const t = document.createElement('i'); t.className = 'tick'; t.textContent = Sel.ids.has(p.id) ? '✓' : '';
      el.appendChild(t);
      el.classList.toggle('picked', Sel.ids.has(p.id));
      el.setAttribute('aria-pressed', String(Sel.ids.has(p.id)));
      el.onclick = () => { Sel.ids.has(p.id) ? Sel.ids.delete(p.id) : Sel.ids.add(p.id); Sel.armed = false; renderMenu(); };
    }
    return el;
  }));
  $('#selToggle').textContent = Sel.on ? 'Terminer' : 'Sélectionner';
  $('#selTools').hidden = !Sel.on;
  const n = Sel.ids.size;
  const del = $('#selDelete');
  del.disabled = !n;
  del.textContent = !n ? 'Supprimer' : Sel.armed ? `Confirmer : supprimer ${n} page${n > 1 ? 's' : ''}` : `Supprimer ${n} page${n > 1 ? 's' : ''}`;

  const sel = $('#livretSelect');
  DB.all('livrets').then(ls => {
    const names = [...new Set(ls.map(l => l.name).concat(S.livret.name))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
    sel.replaceChildren(...names.map(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; o.selected = n === S.livret.name; return o; }));
  });
  $('#pageMode').value = S.set.pageMode || 'page';
  $('#livretTurn').value = S.set.livretTurn || 'gauche';
  $('#livretTurnField').hidden = S.set.pageMode !== 'livret';
  $('#textMode').value = S.set.textMode;
  $('#delay').value = String(S.set.delay);
  $('#ocr').checked = !!S.set.ocr;
  $('#sound').checked = !!S.set.sound;
  $('#clientId').value = S.set.clientId || '';
  $('#drivePath').textContent = `Claude / Scans / ${S.livret.project || S.set.project} / ${S.livret.name}`;
  $('#project').value = S.livret.project || S.set.project || '';
  $('#driveInfo').textContent = !S.set.clientId ? 'Renseigne l\'identifiant client pour activer l\'envoi automatique.'
    : Drive.ok() ? `Connecté jusqu'à ${new Date(Drive.tok.exp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`
    : 'Non connecté : les pages attendent sur le téléphone.';
  $('#ver').textContent = VERSION;
}
const Sel = { on: false, ids: new Set(), armed: false };
$('#selToggle').onclick = () => { Sel.on = !Sel.on; Sel.ids.clear(); Sel.armed = false; renderMenu(); };
$('#selAll').onclick = () => { S.pages.forEach(p => Sel.ids.add(p.id)); Sel.armed = false; renderMenu(); };
$('#selNone').onclick = () => { Sel.ids.clear(); Sel.armed = false; renderMenu(); };
$('#selDelete').onclick = async () => {
  if (!Sel.ids.size) return;
  if (!Sel.armed) { Sel.armed = true; renderMenu(); setTimeout(() => { if (Sel.armed) { Sel.armed = false; if (openSheet === 'menu') renderMenu(); } }, 4000); return; }
  const list = S.pages.filter(p => Sel.ids.has(p.id));
  Sel.ids.clear(); Sel.armed = false; Sel.on = false;
  await deletePages(list);
  toast({ id: 'seldel', kind: 'ok', title: `${list.length} page${list.length > 1 ? 's' : ''} supprimée${list.length > 1 ? 's' : ''}`, text: Drive.ok() ? 'Leurs fichiers Drive partent à la corbeille' : 'Leurs fichiers Drive seront retirés à la prochaine connexion', ttl: 4000 });
  renderMenu();
};
$('#menuBtn').onclick = () => { showSheet('#menuSheet'); renderMenu(); };
$('#livretBtn').onclick = () => { showSheet('#menuSheet'); renderMenu(); };
$('#retakeAll').onclick = () => setRetake(S.pages.filter(p => p.status === 'redo' && !p.kept).map(p => p.num));
$('#syncBtn').onclick = () => syncDrive();
$('#exportZip').onclick = exportZip;
$('#livretSelect').onchange = (e) => switchLivret(e.target.value);
$('#addLivret').onclick = () => {
  const n = $('#newLivret').value.trim();
  if (!n) return;
  $('#newLivret').value = '';
  switchLivret(n);
};
let resetArmed = false;
$('#resetFormat').onclick = async () => {
  if (!resetArmed) { resetArmed = true; $('#resetFormat').textContent = 'Confirmer : le prochain bon cadrage fixera le format'; setTimeout(() => { resetArmed = false; $('#resetFormat').textContent = 'Réinitialiser le format de page de ce livret'; }, 3500); return; }
  resetArmed = false;
  S.livret.size = null; S.livret.aspect = null;
  await DB.put('livrets', S.livret);
  $('#resetFormat').textContent = 'Réinitialiser le format de page de ce livret';
  renderMenu();
};
$('#project').onchange = async (e) => {
  const v = e.target.value.trim(); if (!v) { e.target.value = S.livret.project || S.set.project; return; }
  S.set.project = v; saveSettings();
  if (S.livret.project !== v) {
    S.livret.project = v; S.livret.folders = null; S.livret.reportId = null;
    // les pages déjà envoyées repartiront dans le nouveau dossier à la prochaine synchronisation
    await DB.put('livrets', S.livret);
  }
  renderMenu();
};
$('#textMode').onchange = (e) => { S.set.textMode = e.target.value; saveSettings(); };
$('#pageMode').onchange = (e) => {
  S.set.pageMode = e.target.value; saveSettings(); AC.stableSince = 0; AC.spreadMsg = null;
  $('#livretTurnField').hidden = S.set.pageMode !== 'livret';
};
$('#livretTurn').onchange = (e) => { S.set.livretTurn = e.target.value; saveSettings(); };
$('#delay').onchange = (e) => { S.set.delay = +e.target.value; saveSettings(); };
$('#ocr').onchange = (e) => { S.set.ocr = e.target.checked; saveSettings(); };
$('#sound').onchange = (e) => { S.set.sound = e.target.checked; saveSettings(); };
$('#clientId').onchange = (e) => { S.set.clientId = e.target.value.trim(); saveSettings(); Drive.client = null; renderMenu(); renderDrive(); };
$('#driveConnect').onclick = () => driveConnect();
$('#driveForget').onclick = () => { Drive.forget(); renderMenu(); renderDrive(); };

async function driveConnect() {
  if (!S.set.clientId) {
    showSheet('#menuSheet'); renderMenu();
    $('#clientId').scrollIntoView({ block: 'center' }); $('#clientId').focus();
    toast({ id: 'cid', kind: 'warn', title: 'Identifiant client Google manquant', text: 'Colle-le dans les réglages Drive', ttl: 4000 });
    return;
  }
  try {
    await Drive.connect(LS.get('drive.consented', false) ? '' : 'consent');
    LS.set('drive.consented', true);
    toast({ id: 'drv', kind: 'ok', title: 'Google Drive connecté', text: 'Les bonnes pages partent automatiquement', ttl: 3000 });
  } catch (e) {
    toast({ id: 'drv', kind: 'redo', title: 'Connexion Drive impossible', text: e.message, ttl: 6000 });
  }
  if (openSheet === 'menu') renderMenu();
  pumpUploads();
}
$('#driveBtn').onclick = () => { if (S.set.clientId && Drive.ok()) { showSheet('#menuSheet'); renderMenu(); } else driveConnect(); };

/* ---------- Commandes caméra ---------- */
$('#plainBtn').onclick = () => {
  ensureAudio();
  capture(null, null, true);
  AC.armed = false; AC.captureFp = null;
  setTimeout(() => { AC.armed = !S.set.auto; }, 50);
  toast({ id: 'plain', kind: 'ok', title: 'Photo simple prise', text: 'Envoyée telle quelle, sans recadrage', ttl: 2500 });
};
$('#shutter').onclick = () => {
  ensureAudio();
  const det = S.lastDet && performance.now() - S.lastDetAt < 600 ? S.lastDet : null;
  capture(det, null);
  AC.armed = false; AC.captureFp = null;
  setTimeout(() => { AC.armed = !S.set.auto; }, 50);
};
function setToggle(btn, on) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); }
$('#autoBtn').onclick = () => { S.set.auto = !S.set.auto; saveSettings(); setToggle($('#autoBtn'), S.set.auto); AC.stableSince = 0; };
$('#lockBtn').onclick = () => {
  if (!S.frameLock) {
    if (!S.lastDet || performance.now() - S.lastDetAt > 800) {
      toast({ id: 'lock', kind: 'warn', title: 'Cadre d\'abord le livret', text: 'Le cadre fixe reprend la détection en cours', ttl: 3000 });
      return;
    }
    S.lockedQuad = S.lastDet.quad; S.frameLock = true;
    toast({ id: 'lock', kind: 'ok', title: 'Cadre fixé', text: 'Garde le téléphone immobile, tourne simplement les pages', ttl: 3500 });
  } else { S.frameLock = false; S.lockedQuad = null; }
  setToggle($('#lockBtn'), S.frameLock);
  AC.stableSince = 0; AC.prevFp = null;
};
let torchOn = false;
$('#torchBtn').onclick = async () => {
  if (!track) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
  setToggle($('#torchBtn'), torchOn);
  if (torchOn) toast({ id: 'torch', kind: 'warn', title: 'Lampe allumée', text: 'Attention aux reflets sur le papier glacé', ttl: 3000 });
};

/* ---------- Livrets ---------- */
async function switchLivret(name) {
  S.set.livret = name; saveSettings();
  S.livret = (await DB.get('livrets', name)) || { name, project: S.set.project, size: null, aspect: null, folders: null, reportId: null, created: Date.now() };
  await DB.put('livrets', S.livret);
  const pages = await DB.byLivret(name);
  pages.forEach(p => {
    if (p.status === 'busy') { p.status = 'redo'; p.qRedo = ['analyse interrompue']; }
    if (p.upload.state === 'sending') p.upload.state = 'pending';
    if (p.ocrPending) { p.ocrPending = false; markForUpload(p); }
  });
  S.pages = pages.sort((a, b) => a.num - b.num);
  S.retakeQueue = [];
  S.frameLock = false; S.lockedQuad = null; setToggle($('#lockBtn'), false);
  $('#livretName').textContent = name;
  for (const [, v] of S.urls) URL.revokeObjectURL(v.url);
  S.urls.clear();
  $('#toasts').replaceChildren(); toasts.clear();
  renderRetake(); renderStrip(); renderCounts(); renderDrive();
  if (openSheet === 'menu') renderMenu();
  pumpUploads();
}

/* ---------- Export ZIP (si Drive n'est pas configuré) ---------- */
async function exportZip() {
  const btn = $('#exportZip');
  btn.disabled = true; btn.textContent = 'Préparation…';
  try {
    await loadScript(new URL('lib/jszip.min.js', location.href).href);
    const zip = new JSZip();
    const root = zip.folder(S.livret.name);
    for (const p of S.pages) {
      if (!p.color) continue;
      const n = pad(p.num);
      root.file(`couleur/p${n}.jpg`, p.color);
      root.file(`lecture/p${n}.${p.textExt || 'jpg'}`, p.text);
      p.images.forEach((im, i) => root.file(`images/p${n}-img${i + 1}.jpg`, im.blob));
      if (p.ocr && p.ocr.text) root.file(`texte-lu/p${n}.txt`, p.ocr.text);
    }
    root.file('rapport.json', JSON.stringify(S.pages.map(p => ({ page: p.num, statut: p.status, aRefaire: p.qRedo, aVerifier: p.qWarn, gardee: p.kept })), null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], `${S.livret.name}.zip`, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: S.livret.name }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
  } catch (e) {
    toast({ id: 'zip', kind: 'redo', title: 'Export impossible', text: e.message, ttl: 5000 });
  } finally {
    btn.disabled = false; btn.textContent = 'Exporter en ZIP';
  }
}

/* ---------- Démarrage ---------- */
(async function boot() {
  setToggle($('#autoBtn'), S.set.auto);
  await switchLivret(S.set.livret || 'Cycle 3');
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('resize', () => draw(null));
  startCamera();
  setInterval(renderDrive, 30000);
})();
