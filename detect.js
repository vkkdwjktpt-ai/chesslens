/* ChessLens board finder. Pure JS, no DOM, so it can be tested in Node.
   Idea: a screen board has one strongly coloured square colour (green, brown, blue...). Find the biggest blob of that
   colour, take its convex hull, and shrink the hull down to the 4 straight sides of the board. */
(function (root) {
  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, mx ? d / mx : 0, mx / 255];
  }
  const hdist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  function convexHull(pts) {            // Andrew monotone chain, returns ccw (math orientation) vertices
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }

  function lineX(a, b, c, d) {          // intersection of line ab and line cd
    const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1], x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1];
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }

  // Reduce a convex polygon to 4 sides by repeatedly deleting the edge whose removal adds the least area.
  function toQuad(poly) {
    let P = poly.slice();
    while (P.length > 4) {
      let best = -1, bestA = Infinity, bestX = null;
      const n = P.length;
      for (let i = 0; i < n; i++) {
        const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n], d = P[(i + 2) % n];
        const X = lineX(a, b, c, d); if (!X) continue;
        // X must lie beyond edge bc (outside the polygon): check it is on the outer side of bc
        const side = (c[0] - b[0]) * (X[1] - b[1]) - (c[1] - b[1]) * (X[0] - b[0]);
        if (side > 0) continue;          // ccw polygon: outside is to the right (negative)
        const area = Math.abs((b[0] - X[0]) * (c[1] - X[1]) - (b[1] - X[1]) * (c[0] - X[0])) / 2;
        if (area < bestA) { bestA = area; best = i; bestX = X; }
      }
      if (best < 0) return null;
      const i = best, j = (i + 1) % n;
      const out = [];
      for (let k = 0; k < n; k++) { if (k === i) out.push(bestX); else if (k !== j) out.push(P[k]); }
      P = out;
    }
    return P;
  }

  const LENS = (typeof module !== 'undefined') ? require('./lens.js') : root.Lens;

  // Score how checkerboard-like a candidate quad is: sample 4 points inside every cell and see whether the
  // "coloured" squares alternate like a chessboard (either parity). A real board scores ~0.9, random blobs ~0.5.
  function parityScore(mask, sw, sh, quad) {
    const h = LENS.homography(LENS.BOARD, quad);
    const on = [];
    for (let r = 0; r < 8; r++) {
      on.push([]);
      for (let c = 0; c < 8; c++) {
        let n = 0;
        for (const [du, dv] of [[.22, .22], [.78, .22], [.22, .78], [.78, .78]]) {
          const [x, y] = LENS.warp(h, c + du, r + dv), ix = Math.round(x), iy = Math.round(y);
          if (ix >= 0 && iy >= 0 && ix < sw && iy < sh && mask[iy * sw + ix]) n++;
        }
        on[r].push(n);
      }
    }
    let a = 0, b = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = on[r][c], isOn = v >= 3, isOff = v <= 1, par = (r + c) % 2;
      if ((par === 0 && isOn) || (par === 1 && isOff)) a++;
      if ((par === 1 && isOn) || (par === 0 && isOff)) b++;
    }
    return Math.max(a, b) / 64;
  }

  function morph(src, sw, sh, erode) {
    const out = new Uint8Array(sw * sh);
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      let all = 1, any = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = src[(y + dy) * sw + x + dx]; all &= v; any |= v; }
      out[y * sw + x] = erode ? all : any;
    }
    return out;
  }

  // One candidate: pixels of a given hue family above a saturation threshold -> biggest blob -> hull -> 4 sides.
  function candidate(F, ph, thr) {
    const { sw, sh, N, hue, sat, val } = F;
    const bail = r => { if (F.dbg) F.dbg.push({ ph, thr, bail: r }); return null; };
    let mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = (sat[i] >= thr && val[i] >= 0.16 && hdist(hue[i], ph) <= 32) ? 1 : 0;
    mask = morph(morph(mask, sw, sh, true), sw, sh, false);      // opening: drop specks
    const joined = morph(mask, sw, sh, false);                   // dilate so squares touching at corners join up
    const lab = new Int32Array(N); let best = 0, bestLab = 0, L = 0; const stack = [];
    for (let i = 0; i < N; i++) {
      if (!joined[i] || lab[i]) continue;
      L++; let size = 0; stack.push(i); lab[i] = L;
      while (stack.length) {
        const p = stack.pop(); if (mask[p]) size++;
        const x = p % sw, y = (p - x) / sw;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const q = ny * sw + nx; if (joined[q] && !lab[q]) { lab[q] = L; stack.push(q); }
        }
      }
      if (size > best) { best = size; bestLab = L; }
    }
    if (best < N * 0.02) return bail('blob ' + (best / N).toFixed(4));
    const pts = [];
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x; if (!mask[i] || lab[i] !== bestLab) continue;
      if (!mask[i - 1] || !mask[i + 1] || !mask[i - sw] || !mask[i + sw]) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }
    if (pts.length < 12) return bail('pts');
    const hull = convexHull(pts); if (hull.length < 4) return bail('hull');
    const q4 = toQuad(hull); if (!q4 || q4.length !== 4) return bail('toQuad');
    const cx = q4.reduce((s, p) => s + p[0], 0) / 4, cy = q4.reduce((s, p) => s + p[1], 0) / 4;
    let ord = q4.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let tl = 0; ord.forEach((p, i) => { if (p[0] + p[1] < ord[tl][0] + ord[tl][1]) tl = i; });
    ord = ord.slice(tl).concat(ord.slice(0, tl));
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const top = d(ord[0], ord[1]), right = d(ord[1], ord[2]), bot = d(ord[2], ord[3]), left = d(ord[3], ord[0]);
    const area = Math.abs(ord.reduce((s, p, i) => { const n = ord[(i + 1) % 4]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
    const ar = ((top + bot) / 2) / ((left + right) / 2);
    if (area < N * 0.04 || ar < 0.6 || ar > 1.7 || Math.max(top, bot) / Math.min(top, bot) > 1.6 || Math.max(left, right) / Math.min(left, right) > 1.6) return bail('shape a=' + (area / N).toFixed(3) + ' ar=' + ar.toFixed(2));
    const score = parityScore(mask, sw, sh, ord);
    return { ord, score, fill: best / area, area };
  }

  /* rgba: Uint8ClampedArray of the camera frame (W x H). Returns {quad, score} with quad = [TL,TR,BR,BL] normalised 0..1,
     or {fail} when no convincing board is visible. */
  function detectBoard(rgba, W, H, dbg) {
    const sw = Math.min(W, 256), sh = Math.max(8, Math.round(H * sw / W)), sc = W / sw;
    const N = sw * sh, hue = new Float32Array(N), sat = new Float32Array(N), val = new Float32Array(N);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const px = Math.min(W - 1, Math.floor((x + dx * 0.5) * sc)), py = Math.min(H - 1, Math.floor((y + dy * 0.5) * sc)), o = (py * W + px) * 4;
        r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n++;
      }
      const [h, s, v] = hsv(r / n, g / n, b / n), i = y * sw + x; hue[i] = h; sat[i] = s; val[i] = v;
    }
    const F = { sw, sh, N, hue, sat, val, dbg };
    const hist = new Float32Array(36); let tot = 0;
    for (let i = 0; i < N; i++) if (sat[i] >= 0.22 && val[i] >= 0.18) { hist[Math.floor(hue[i] / 10) % 36]++; tot++; }
    if (tot < N * 0.004) return { fail: 'no colour' };
    const sm = k => hist[(k + 35) % 36] + hist[k] * 2 + hist[(k + 1) % 36];
    let k1 = 0; for (let k = 1; k < 36; k++) if (sm(k) > sm(k1)) k1 = k;
    let k2 = -1;
    for (let k = 0; k < 36; k++) { const dk = Math.min((k - k1 + 36) % 36, (k1 - k + 36) % 36); if (dk >= 4 && (k2 < 0 || sm(k) > sm(k2))) k2 = k; }
    const peaks = [k1 * 10 + 5]; if (k2 >= 0 && sm(k2) > 0.25 * sm(k1)) peaks.push(k2 * 10 + 5);

    let best = null;
    outer: for (const ph of peaks) for (const thr of [0.38, 0.3, 0.46, 0.24, 0.55, 0.18]) {
      if (best && best.score >= 0.9) break outer;          // good enough, stop early to save time
      const c = candidate(F, ph, thr);
      if (dbg) dbg.push({ ph, thr, score: c && c.score, area: c && c.area, fill: c && c.fill });
      if (c && (!best || c.score > best.score + 0.02 || (Math.abs(c.score - best.score) <= 0.02 && c.area > best.area))) best = Object.assign(c, { hue: ph, thr });
    }
    if (!best) return { fail: 'no blob' };
    if (best.score < 0.72) return { fail: 'not a board (' + best.score.toFixed(2) + ')' };
    return { quad: best.ord.map(p => [Math.min(1, Math.max(0, p[0] / sw)), Math.min(1, Math.max(0, p[1] / sh))]), score: best.score, fill: best.fill, hue: best.hue, thr: best.thr };
  }

  const api = { detectBoard };
  if (typeof module !== 'undefined') module.exports = api; else root.Detect = api;
})(typeof self !== 'undefined' ? self : this);
