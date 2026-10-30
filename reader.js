/* ChessLens fast readers.
   Reader     : on-screen boards. Looks at a tiny 8x8 fingerprint of every square each frame and only re-runs the piece
                recogniser on squares whose fingerprint changed (plus a slow round-robin refresh). A new label must be
                seen twice before it is accepted. Typical cost per static frame: ~4000 pixel reads.
   RealReader : physical boards. Learns what empty / white piece / black piece look like from the starting position
                (calibration) and then only answers empty / white / black per square. */
(function (root) {
  const L = (typeof module !== 'undefined') ? require('./lens.js') : root.Lens;
  const N = 32, T_CHANGE = 0.35;

  function lumAt(d, W, H, px, py) {
    let ix = px | 0, iy = py | 0;
    if (ix < 0) ix = 0; else if (ix >= W) ix = W - 1;
    if (iy < 0) iy = 0; else if (iy >= H) iy = H - 1;
    const o = (iy * W + ix) * 4; return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  }
  const maxMove = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

  class Reader {
    constructor(model) { this.model = model; this.reset(); }
    reset() {
      this.sig = new Array(64).fill(null); this.acc = new Array(64).fill(null); this.cand = new Array(64).fill(null);
      this.pend = new Uint8Array(64); this.rr = 0; this.q = null; this.x = new Float32Array(N * N); this.reclass = 0;
    }
    classify(d, W, H, h, r, c) {
      const x = this.x, m = this.model; let sum = 0;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let a = 0;
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          const u = c + (i + (sx + .5) / 2) / N, v = r + (j + (sy + .5) / 2) / N, dd = h[6] * u + h[7] * v + 1;
          a += lumAt(d, W, H, (h[0] * u + h[1] * v + h[2]) / dd, (h[3] * u + h[4] * v + h[5]) / dd);
        }
        a /= 4; x[j * N + i] = a; sum += a;
      }
      const mean = sum / (N * N); let v2 = 0;
      for (let k = 0; k < N * N; k++) { const t = x[k] - mean; v2 += t * t; }
      const sd = Math.sqrt(v2 / (N * N));
      for (let k = 0; k < N * N; k++) x[k] = (x[k] - mean) / (sd + m.meta.eps);
      return m.meta.classes[L.forward(m, x)];
    }
    // d: RGBA frame, quad: normalised corners TL,TR,BR,BL. Returns {names: 8x8 accepted labels, reclass: squares re-read}
    update(d, W, H, quad) {
      if (!this.q || maxMove(this.q, quad) > 0.012) { this.q = quad.map(p => p.slice()); this.sig.fill(null); }
      const q = this.q, h = L.homography(L.BOARD, q.map(([x, y]) => [x * W, y * H]));
      const s8 = new Float32Array(64), rr1 = this.rr, rr2 = (this.rr + 1) % 64; this.rr = (this.rr + 2) % 64; let n = 0;
      for (let i = 0; i < 64; i++) {
        const r = i >> 3, c = i & 7; let sum = 0;
        for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) {
          const u = c + (a + .5) / 8, v = r + (b + .5) / 8, dd = h[6] * u + h[7] * v + 1;
          const g = lumAt(d, W, H, (h[0] * u + h[1] * v + h[2]) / dd, (h[3] * u + h[4] * v + h[5]) / dd); s8[b * 8 + a] = g; sum += g;
        }
        const mean = sum / 64; let vs = 0;
        for (let k = 0; k < 64; k++) { const t = s8[k] - mean; vs += t * t; }
        const sd = Math.sqrt(vs / 64);
        for (let k = 0; k < 64; k++) s8[k] = (s8[k] - mean) / (sd + 8);
        const prev = this.sig[i]; let diff = 99;
        if (prev) { diff = 0; for (let k = 0; k < 64; k++) diff += Math.abs(s8[k] - prev[k]); diff /= 64; }
        if (diff > T_CHANGE || this.pend[i] || i === rr1 || i === rr2) {
          const raw = this.classify(d, W, H, h, r, c); this.sig[i] = Float32Array.from(s8); n++;
          if (this.acc[i] === null || raw === this.acc[i]) { this.acc[i] = raw; this.cand[i] = null; this.pend[i] = 0; }
          else if (this.cand[i] && this.cand[i].l === raw) { if (++this.cand[i].n >= 2) { this.acc[i] = raw; this.cand[i] = null; this.pend[i] = 0; } }
          else { this.cand[i] = { l: raw, n: 1 }; this.pend[i] = 1; }
        }
      }
      this.reclass = n;
      const names = []; for (let r = 0; r < 8; r++) names.push(this.acc.slice(r * 8, r * 8 + 8));
      return { names, reclass: n };
    }
  }

  /* ---------------- real boards ---------------- */
  const G = 12;                                          // 12x12 samples in the central 70% of each square
  function sampleSquares(d, W, H, quad) {
    const h = L.homography(L.BOARD, quad.map(([x, y]) => [x * W, y * H])), out = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const lum = new Float32Array(G * G); let R = 0, Gc = 0, B = 0, L1 = 0;
      for (let b = 0; b < G; b++) for (let a = 0; a < G; a++) {
        const u = c + .15 + .7 * (a + .5) / G, v = r + .15 + .7 * (b + .5) / G, dd = h[6] * u + h[7] * v + 1;
        let ix = Math.round((h[0] * u + h[1] * v + h[2]) / dd), iy = Math.round((h[3] * u + h[4] * v + h[5]) / dd);
        ix = Math.min(W - 1, Math.max(0, ix)); iy = Math.min(H - 1, Math.max(0, iy)); const o = (iy * W + ix) * 4;
        R += d[o]; Gc += d[o + 1]; B += d[o + 2]; const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; lum[b * G + a] = l; L1 += l;
      }
      const n = G * G; let sd = 0, gr = 0; const m = L1 / n;
      for (let k = 0; k < n; k++) sd += (lum[k] - m) * (lum[k] - m);
      for (let b = 0; b < G; b++) for (let a = 0; a < G - 1; a++) gr += Math.abs(lum[b * G + a + 1] - lum[b * G + a]) + Math.abs(lum[(a + 1) * G + b] - lum[a * G + b]);
      out.push({ r, c, p: (r + c) & 1, lum, rgb: [R / n, Gc / n, B / n, m], sd: Math.sqrt(sd / n), gr: gr / (2 * G * (G - 1)) });
    }
    return out;
  }
  function solve3(A, b) {                                // 3x3 least squares via normal equations
    const M = A.map((row, i) => row.concat(b[i]));
    for (let i = 0; i < 3; i++) {
      let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      [M[i], M[p]] = [M[p], M[i]]; const dv = M[i][i] || 1e-9;
      for (let k = i + 1; k < 3; k++) { const f = M[k][i] / dv; for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]; }
    }
    const x = [0, 0, 0]; for (let i = 2; i >= 0; i--) { let s = M[i][3]; for (let j = i + 1; j < 3; j++) s -= M[i][j] * x[j]; x[i] = s / (M[i][i] || 1e-9); } return x;
  }
  function fitPlane(pts, vals) {                         // vals ~ a + b*r + c*col
    const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
    pts.forEach(([r, c], i) => { const f = [1, r, c]; for (let a = 0; a < 3; a++) { Atb[a] += f[a] * vals[i]; for (let b = 0; b < 3; b++) AtA[a][b] += f[a] * f[b]; } });
    for (let a = 0; a < 3; a++) AtA[a][a] += 1e-6;
    return solve3(AtA, Atb);
  }
  const sigm = z => 1 / (1 + Math.exp(-z));

  class RealReader {
    constructor() { this.cal = null; this.acc = new Array(64).fill(null); this.cand = new Array(64).fill(null); }
    ref(sq) { const k = this.cal.ref[sq.p]; return k.map(co => co[0] + co[1] * sq.r + co[2] * sq.c); }   // [R,G,B,L]
    feat(sq) {
      const ref = this.ref(sq), dev = Math.hypot(sq.rgb[0] - ref[0], sq.rgb[1] - ref[1], sq.rgb[2] - ref[2]);
      let cover = 0; for (let k = 0; k < sq.lum.length; k++) if (Math.abs(sq.lum[k] - ref[3]) > 25) cover++;
      cover /= sq.lum.length;
      return [dev / 40, sq.sd / 30, sq.gr / 12, cover, 1];
    }
    pieceLum(sq) {
      const ref = this.ref(sq); let s = 0, n = 0;
      for (let k = 0; k < sq.lum.length; k++) if (Math.abs(sq.lum[k] - ref[3]) > 20) { s += sq.lum[k]; n++; }
      return n >= sq.lum.length * 0.12 ? s / n : sq.rgb[3];
    }
    // sq: sampleSquares() of the starting position. whiteBottom: which colour is nearest the camera.
    calibrate(sqs, whiteBottom) {
      const cal = { ref: [null, null] };
      for (const p of [0, 1]) {
        const e = sqs.filter(s => s.p === p && s.r >= 2 && s.r <= 5), pts = e.map(s => [s.r, s.c]);
        cal.ref[p] = [0, 1, 2, 3].map(ch => fitPlane(pts, e.map(s => s.rgb[ch])));
      }
      this.cal = cal;
      const X = [], y = [];
      for (const s of sqs) { X.push(this.feat(s)); y.push(s.r < 2 || s.r > 5 ? 1 : 0); }
      let w = [0, 0, 0, 0, 0];
      for (let it = 0; it < 1500; it++) {
        const gw = [0, 0, 0, 0, 0];
        X.forEach((f, i) => { const e = sigm(f.reduce((a, v, k) => a + v * w[k], 0)) - y[i]; f.forEach((v, k) => gw[k] += e * v); });
        w = w.map((v, k) => v - 0.3 * gw[k] / X.length);
      }
      let ok = 0; X.forEach((f, i) => { if ((sigm(f.reduce((a, v, k) => a + v * w[k], 0)) > .5 ? 1 : 0) === y[i]) ok++; });
      cal.w = w;
      const whiteRows = whiteBottom ? [6, 7] : [0, 1], cen = { 0: { w: [], b: [] }, 1: { w: [], b: [] } };
      for (const s of sqs) if (s.r < 2 || s.r > 5) cen[s.p][whiteRows.includes(s.r) ? 'w' : 'b'].push(this.pieceLum(s));
      const mean = a => a.reduce((x, v) => x + v, 0) / (a.length || 1);
      cal.cen = [0, 1].map(p => ({ w: mean(cen[p].w), b: mean(cen[p].b) }));
      this.acc.fill(null); this.cand.fill(null);
      const sep = Math.min(Math.abs(cal.cen[0].w - cal.cen[0].b), Math.abs(cal.cen[1].w - cal.cen[1].b));
      return { acc: ok / 64, sep };
    }
    // returns 8x8 of '' | 'w' | 'b' in camera orientation
    read(sqs) {
      if (!this.cal) return null;
      sqs.forEach((s, i) => {
        const f = this.feat(s), occ = sigm(f.reduce((a, v, k) => a + v * this.cal.w[k], 0)) > 0.5; let raw = '';
        if (occ) { const pl = this.pieceLum(s), c = this.cal.cen[s.p]; raw = Math.abs(pl - c.w) <= Math.abs(pl - c.b) ? 'w' : 'b'; }
        if (this.acc[i] === null || raw === this.acc[i]) { this.acc[i] = raw; this.cand[i] = null; }
        else if (this.cand[i] && this.cand[i].l === raw) { if (++this.cand[i].n >= 2) { this.acc[i] = raw; this.cand[i] = null; } }
        else this.cand[i] = { l: raw, n: 1 };
      });
      const g = []; for (let r = 0; r < 8; r++) g.push(this.acc.slice(r * 8, r * 8 + 8)); return g;
    }
  }

  const api = { Reader, RealReader, sampleSquares };
  if (typeof module !== 'undefined') module.exports = api; else root.Readers = api;
})(typeof self !== 'undefined' ? self : this);
