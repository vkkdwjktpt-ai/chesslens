/* ChessLens game tracker. Follows the game move by move using the rules of chess, so the app always knows whose turn it is
   and ignores anything that is not a legal move (mouse cursor, a hand over the board, a piece being dragged).
   mode 'pieces': observations are FEN piece placements (on-screen boards, pieces recognised).
   mode 'occ'   : observations only say white / black / empty per square (real boards, game starts from the initial position). */
(function (root) {
  const Chess = (typeof module !== 'undefined') ? require('./chess.js').Chess : root.Chess;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const expand = pl => pl.split('/').map(row => { const o = []; for (const ch of row) { if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) o.push(''); else o.push(ch); } return o; });
  const compress = rows => rows.map(row => { let s = '', e = 0; for (const p of row) { if (!p) e++; else { if (e) { s += e; e = 0; } s += p; } } return e ? s + e : s; }).join('/');
  const occKey = pl => compress(expand(pl).map(r => r.map(p => p ? (p === p.toUpperCase() ? 'w' : 'b') : '')));
  const colorOf = p => (p === p.toUpperCase() ? 'w' : 'b');
  function castleGuess(pl) {
    const g = expand(pl); let c = '';
    if (g[7][4] === 'K') { if (g[7][7] === 'R') c += 'K'; if (g[7][0] === 'R') c += 'Q'; }
    if (g[0][4] === 'k') { if (g[0][7] === 'r') c += 'k'; if (g[0][0] === 'r') c += 'q'; }
    return c || '-';
  }
  function moverColor(a, b) {          // colour of the pieces that newly appeared on squares that changed
    const A = expand(a), B = expand(b), s = new Set();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (A[r][c] !== B[r][c] && B[r][c]) s.add(colorOf(B[r][c]));
    return s.size === 1 ? [...s][0] : null;
  }

  class Tracker {
    constructor(mode) { this.mode = mode || 'pieces'; this.reset(); }
    key(pl) { return this.mode === 'pieces' ? pl : occKey(pl); }
    reset() { this.chess = null; this.c1 = null; this.c2 = null; this.pend = null; this.lastMove = null; this.guessed = false; }
    get fen() { return this.chess ? this.chess.fen() : null; }
    get turn() { return this.chess ? this.chess.turn() : null; }
    get placement() { return this.chess ? this.chess.fen().split(' ')[0] : null; }
    startGame() { this.chess = new Chess(); this.c1 = this.c2 = null; this.pend = null; this.guessed = false; this.lastMove = null; }
    load(placement, turn) {
      const c = new Chess();
      if (!c.load(`${placement} ${turn} ${castleGuess(placement)} - 0 1`)) return false;
      this.chess = c; this.c1 = this.c2 = null; this.pend = null; return true;
    }
    flipTurn() {
      if (!this.chess) return false;
      const f = this.chess.fen().split(' '); f[1] = f[1] === 'w' ? 'b' : 'w'; f[3] = '-';
      const c = new Chess(); if (!c.load(f.join(' '))) return false;
      this.chess = c; this.c1 = this.c2 = null; this.guessed = true; return true;
    }
    _add(map, k, path) {
      const old = map.get(k);
      if (!old || (old[old.length - 1].promotion && old[old.length - 1].promotion !== 'q' && path[path.length - 1].promotion === 'q')) map.set(k, path);
    }
    reach1() {                                   // every position one legal move away
      const fen = this.chess.fen(); if (this.c1 && this.c1.fen === fen) return this.c1.map;
      const map = new Map(), c = this.chess;
      for (const m of c.moves({ verbose: true })) { c.move(m); this._add(map, this.key(c.fen().split(' ')[0]), [m]); c.undo(); }
      this.c1 = { fen, map }; return map;
    }
    reach2() {                                   // two moves away (a fast reply before we looked)
      const fen = this.chess.fen(); if (this.c2 && this.c2.fen === fen) return this.c2.map;
      const map = new Map(), c = this.chess, one = this.reach1();
      for (const m1 of c.moves({ verbose: true })) {
        c.move(m1);
        for (const m2 of c.moves({ verbose: true })) { c.move(m2); const k = this.key(c.fen().split(' ')[0]); if (!one.has(k)) this._add(map, k, [m1, m2]); c.undo(); }
        c.undo();
      }
      this.c2 = { fen, map }; return map;
    }
    // obs: placement string in this tracker's key space. Returns {type: init|same|move|unmatched|resync|invalid|idle}
    observe(obs, now, myColor) {
      if (!this.chess) {
        if (this.mode !== 'pieces') return { type: 'idle' };
        if (obs === START) { this.startGame(); return { type: 'init', guessed: false }; }
        if (this.load(obs, myColor)) { this.guessed = true; return { type: 'init', guessed: true }; }
        return { type: 'invalid' };
      }
      if (obs === this.key(this.placement)) { this.pend = null; return { type: 'same' }; }
      let path = this.reach1().get(obs) || this.reach2().get(obs);
      if (path) {
        const done = [];
        for (const m of path) { const r = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion }); if (r) done.push(r); }
        this.c1 = this.c2 = null; this.pend = null; this.guessed = false; this.lastMove = done[done.length - 1] || null;
        return { type: 'move', moves: done };
      }
      if (!this.pend || this.pend.k !== obs) this.pend = { k: obs, since: now };
      const ms = now - this.pend.since;
      if (this.mode === 'pieces' && ms > 1200) {        // stuck on something that is not a legal move: trust the camera and re-sync
        const mc = moverColor(this.placement, obs), turn = mc ? (mc === 'w' ? 'b' : 'w') : this.chess.turn();
        if (this.load(obs, turn)) { this.guessed = !mc; return { type: 'resync' }; }
        this.pend = null; return { type: 'invalid' };
      }
      return { type: 'unmatched', ms };
    }
  }
  const api = { Tracker, START, expand, compress, occKey };
  if (typeof module !== 'undefined') module.exports = api; else root.TrackerLib = api;
})(typeof self !== 'undefined' ? self : this);
