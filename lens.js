/* ChessLens core: board warp, piece classifier (tiny MLP), FEN builder. No DOM access, so it can be tested in Node. */
(function (root) {
  const FC = { empty: '', wp: 'P', wn: 'N', wb: 'B', wr: 'R', wq: 'Q', wk: 'K', bp: 'p', bn: 'n', bb: 'b', br: 'r', bq: 'q', bk: 'k' };

  // Solve the perspective transform mapping 4 source points to 4 destination points.
  function homography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        B[r] -= f * B[i];
      }
    }
    const h = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = B[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * h[c];
      h[i] = s / A[i][i];
    }
    return h;
  }
  function warp(h, u, v) {
    const d = h[6] * u + h[7] * v + 1;
    return [(h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d];
  }
  const BOARD = [[0, 0], [8, 0], [8, 8], [0, 8]];

  function makeModel(meta, floats) {
    let off = 0; const L = [];
    for (let i = 0; i < meta.layers.length - 1; i++) {
      const a = meta.layers[i], b = meta.layers[i + 1];
      const W = floats.subarray(off, off + a * b); off += a * b;
      const B = floats.subarray(off, off + b); off += b;
      L.push({ a, b, W, B });
    }
    return { meta, L };
  }
  function forward(model, x) {
    let h = x;
    model.L.forEach((l, li) => {
      const o = new Float32Array(l.b); o.set(l.B);
      for (let i = 0; i < l.a; i++) {
        const xi = h[i]; if (xi === 0) continue;
        const base = i * l.b;
        for (let j = 0; j < l.b; j++) o[j] += xi * l.W[base + j];
      }
      if (li < model.L.length - 1) for (let j = 0; j < l.b; j++) if (o[j] < 0) o[j] = 0;
      h = o;
    });
    let m = -Infinity, k = 0;
    for (let j = 0; j < h.length; j++) if (h[j] > m) { m = h[j]; k = j; }
    return k;
  }

  // gray: Float32Array (W*H) of the camera frame. quad: 4 corners (TL,TR,BR,BL) normalised 0..1.
  // Returns 8x8 class names, row 0 = the top edge of the quad.
  function classifyGrid(model, gray, W, H, quad) {
    const h = homography(BOARD, quad.map(([x, y]) => [x * W, y * H]));
    const N = model.meta.size, x = new Float32Array(N * N), grid = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let c = 0; c < 8; c++) {
        let sum = 0;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          let a = 0;
          for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
            const u = c + (i + (sx + 0.5) / 2) / N, v = r + (j + (sy + 0.5) / 2) / N;
            const d = h[6] * u + h[7] * v + 1;
            const px = (h[0] * u + h[1] * v + h[2]) / d, py = (h[3] * u + h[4] * v + h[5]) / d;
            const ix = Math.min(W - 1, Math.max(0, px | 0)), iy = Math.min(H - 1, Math.max(0, py | 0));
            a += gray[iy * W + ix];
          }
          a /= 4; x[j * N + i] = a; sum += a;
        }
        const mean = sum / (N * N); let v2 = 0;
        for (let k = 0; k < N * N; k++) { const t = x[k] - mean; v2 += t * t; }
        const sd = Math.sqrt(v2 / (N * N));
        for (let k = 0; k < N * N; k++) x[k] = (x[k] - mean) / (sd + model.meta.eps);
        row.push(model.meta.classes[forward(model, x)]);
      }
      grid.push(row);
    }
    return grid;
  }

  // Returns {fen, board} (board row 0 = rank 8) or null if the reading is not a plausible position.
  function toFen(names, whiteBottom, whiteToMove) {
    let g = names.map(r => r.map(n => FC[n]));
    if (!whiteBottom) g = g.slice().reverse().map(r => r.slice().reverse());
    const flat = g.flat();
    const count = ch => flat.filter(p => p === ch).length;
    if (count('K') !== 1 || count('k') !== 1) return null;
    if (count('P') > 8 || count('p') > 8) return null;
    if (g[0].some(p => p === 'P' || p === 'p') || g[7].some(p => p === 'P' || p === 'p')) return null;
    if (flat.filter(p => p && p === p.toUpperCase()).length > 16 || flat.filter(p => p && p === p.toLowerCase()).length > 16) return null;
    let kw, kb;
    g.forEach((row, r) => row.forEach((p, c) => { if (p === 'K') kw = [r, c]; if (p === 'k') kb = [r, c]; }));
    if (Math.abs(kw[0] - kb[0]) <= 1 && Math.abs(kw[1] - kb[1]) <= 1) return null;
    const placement = g.map(row => {
      let s = '', e = 0;
      for (const p of row) { if (!p) e++; else { if (e) { s += e; e = 0; } s += p; } }
      return e ? s + e : s;
    }).join('/');
    return { fen: `${placement} ${whiteToMove ? 'w' : 'b'} - - 0 1`, board: g };
  }

  const api = { homography, warp, BOARD, makeModel, classifyGrid, toFen, forward };
  if (typeof module !== 'undefined') module.exports = api; else root.Lens = api;
})(typeof self !== 'undefined' ? self : this);
