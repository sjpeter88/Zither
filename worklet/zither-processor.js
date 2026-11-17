// Concert zither string engine — extended Karplus-Strong, one model per string.
//
// Per string, per sample:
//   delay line --cubic Lagrange fractional read--> one-pole damping filter
//   --> 4 first-order all-passes (stiffness / dispersion) --> bridge
//
// All strings meet at one bridge, modelled as a memoryless scattering junction
// with a real, positive bridge impedance Zb:
//     vb     = sum_i a_i * y_i          a_i = 2 Z_i / (Zb + sum Z)
//     back_i = y_i - vb                 (what re-enters string i)
// Power in minus power out of the junction is exactly Zb * vb^2 >= 0, so the
// junction can only remove energy. Every loop element has gain <= 1, so the
// coupled network is passive: sympathetic strings exchange energy but the
// total can never grow, whatever is played.
//
// This file has no imports so it can be loaded both as an AudioWorklet module
// and by Node (tools/verify.mjs) for offline numerical checks.
(function (root) {
  'use strict';

  const NAP = 4;                 // all-pass stages per string
  const TWO_PI = 2 * Math.PI;

  // Shallow spruce soundbox: [frequency Hz, gain, Q, stereo offset]. Air mode
  // sits higher than a guitar's and the plate modes are weighted towards the
  // upper mids, which is what makes a zither sound bright and thin.
  const BODY_MODES = [
    [192, 0.50, 9, 0.0], [268, 0.62, 14, -0.2], [351, 0.55, 16, 0.25], [436, 0.42, 18, -0.3],
    [548, 0.62, 20, 0.3], [702, 0.58, 22, -0.25], [915, 0.66, 24, 0.2], [1180, 0.60, 26, -0.3],
    [1530, 0.58, 26, 0.3], [1990, 0.52, 28, -0.2], [2580, 0.48, 28, 0.25], [3350, 0.40, 26, -0.3],
    [4300, 0.30, 24, 0.3], [5600, 0.20, 20, 0.0],
  ];

  class ZitherEngine {
    constructor(sampleRate, cfg) {
      const sr = this.sr = sampleRate;
      const S = this.cfg = cfg.strings;
      const n = this.n = S.length;
      let size = 1024;
      while (size < sr / 24) size <<= 1;         // room for the lowest string at any sample rate
      this.BUF = size; this.MASK = size - 1;

      this.buf = new Float64Array(n * size);
      this.w = 0;
      this.dl = new Float64Array(n); this.dEnd = new Float64Array(n); this.dInc = new Float64Array(n);
      this.di = new Int32Array(n);
      this.h0 = new Float64Array(n); this.h1 = new Float64Array(n);
      this.h2 = new Float64Array(n); this.h3 = new Float64Array(n);
      this.lpB = new Float64Array(n); this.lpP = new Float64Array(n); this.lpS = new Float64Array(n);
      this.apA = new Float64Array(n); this.apZ = new Float64Array(n * NAP);
      this.Y = new Float64Array(n);
      this.cA = new Float64Array(n); this.wL = new Float64Array(n); this.wR = new Float64Array(n);
      this.exc = new Float32Array(n * size); this.excPos = new Int32Array(n); this.excLen = new Int32Array(n);
      this.tmp = new Float32Array(size);
      this.curF = new Float64Array(n); this.tgtF = new Float64Array(n);
      this.glide = new Uint8Array(n); this.tau = new Float64Array(n).fill(0.006);
      this.fret = new Int16Array(n); this.bend = new Float64Array(n); this.damped = new Uint8Array(n);
      this.dampUntil = new Float64Array(n);
      this.vibDepth = new Float64Array(n); this.vibRate = new Float64Array(n);
      this.vibStart = new Float64Array(n); this.vibPhase = new Float64Array(n);

      this.master = cfg.master == null ? 1 : cfg.master;
      this.bright = 1;
      this.queue = [];
      this.now = 0;
      this.asleep = true; this.quiet = 0;
      this.peakPre = 0; this.peakString = 0;
      this.seed = 0x2545F491;
      this.reportEvery = Math.round(sr / 30); this.reportCount = 0;
      this.onReport = null;

      for (let i = 0; i < n; i++) {
        const g = 0.3 * (S[i].outGain == null ? 1 : S[i].outGain);
        const pan = S[i].pan || 0;
        this.wL[i] = g * Math.cos((pan + 1) * Math.PI / 4);
        this.wR[i] = g * Math.sin((pan + 1) * Math.PI / 4);
        this.curF[i] = this.tgtF[i] = S[i].freq;
      }

      // body resonator bank (band-pass biquads, transposed direct form II)
      const M = this.nm = BODY_MODES.length;
      this.mb = new Float64Array(M); this.ma1 = new Float64Array(M); this.ma2 = new Float64Array(M);
      this.mz1 = new Float64Array(M); this.mz2 = new Float64Array(M);
      this.mgL = new Float64Array(M); this.mgR = new Float64Array(M);
      for (let k = 0; k < M; k++) {
        const [f, gain, Q, off] = BODY_MODES[k];
        if (f > 0.45 * sr) continue;
        const w0 = TWO_PI * f / sr, alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
        this.mb[k] = alpha / a0; this.ma1[k] = -2 * Math.cos(w0) / a0; this.ma2[k] = (1 - alpha) / a0;
        this.mgL[k] = gain * (1 - off); this.mgR[k] = gain * (1 + off);
      }
      this.hpK = 1 - Math.exp(-TWO_PI * 95 / sr);
      this.hpL = 0; this.hpR = 0;

      this.setResonance(cfg.resonance == null ? 0.5 : cfg.resonance);
    }

    // ---- parameters ----------------------------------------------------------
    setResonance(r) {
      r = Math.min(1, Math.max(0, r));
      this.resonance = r;
      let sumZ = 0;
      for (let i = 0; i < this.n; i++) sumZ += this.cfg[i].z;
      // total impedance seen at the bridge; always > sumZ, so Zb > 0 (passive)
      const Zt = Math.max(sumZ * 1.5, 760 / (0.2 + 1.6 * r));
      this.Zb = Zt - sumZ;
      for (let i = 0; i < this.n; i++) this.cA[i] = 2 * this.cfg[i].z / Zt;
      for (let i = 0; i < this.n; i++) this._retune(i, true);
    }

    _rand() {            // xorshift32, deterministic so offline tests are repeatable
      let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x;
      return (x >>> 0) / 4294967296;
    }

    /** Filter coefficients for string i at frequency f; returns the delay-line
     *  length that makes the whole loop exactly one period long at f. */
    _coefs(i, f) {
      const sr = this.sr, c = this.cfg[i];
      const w0 = TWO_PI * f / sr, period = sr / f;
      const fr = this.fret[i];
      const t60 = this.damped[i] ? 0.1 : c.t60 * (fr > 0 ? 0.55 + 0.45 * Math.pow(2, -fr / 12) : 1);
      const G = Math.pow(10, -3 / (f * t60));                 // loop gain per round trip at f
      // damping pole from a target decay time at a high reference frequency
      const fh = Math.min(0.42 * sr, Math.max(3000, 3 * f));
      const thf = Math.min(t60, c.hf * this.bright * Math.pow(3000 / fh, 0.7));
      const ratio = Math.pow(10, -3 / (f * thf)) / G;
      const c0 = Math.cos(w0), ch = Math.cos(TWO_PI * fh / sr);
      let p = 0;
      if (ratio < 0.9999999) {
        let lo = 0, hi = 0.97;
        for (let k = 0; k < 26; k++) {
          const m = 0.5 * (lo + hi);
          const r = Math.sqrt((1 - 2 * m * c0 + m * m) / (1 - 2 * m * ch + m * m));   // |H(wh)| / |H(w0)|
          if (r > ratio) lo = m; else hi = m;
        }
        p = 0.5 * (lo + hi);
      }
      const m0 = (1 - p) / Math.sqrt(1 - 2 * p * c0 + p * p);
      // At least half of the decay (in dB) is always lost inside the string
      // itself, so even a mode that sends nothing into the bridge (two unison
      // strings moving in opposition) dies away. g <= 1 keeps the loop passive.
      let g = Math.min(G / (1 - this.cA[i]), Math.sqrt(G)) / m0;
      if (g > 1) g = 1;
      this.lpP[i] = p; this.lpB[i] = g * (1 - p);

      // stiffness: all-pass delay falls with frequency, so upper partials run sharp
      let ds = c.disp * period / NAP;
      if (ds < 1) ds = 1; else if (ds > 12) ds = 12;
      const a = (1 - ds) / (1 + ds);
      this.apA[i] = a;
      const s0 = Math.sin(w0);
      const pdAP = a === 0 ? 1 : -(Math.atan2(-s0, a + c0) - Math.atan2(-a * s0, 1 + a * c0)) / w0;
      const pdLP = p === 0 ? 0 : Math.atan2(p * s0, 1 - p * c0) / w0;
      let L = period - pdLP - NAP * pdAP;
      if (L < 2) L = 2;
      return L;
    }

    _taps(i, d) {
      const ii = Math.floor(d), x = d - ii + 1;      // x in [1,2): centred cubic Lagrange
      this.di[i] = ii;
      this.h0[i] = -(x - 1) * (x - 2) * (x - 3) / 6;
      this.h1[i] = x * (x - 2) * (x - 3) / 2;
      this.h2[i] = -x * (x - 1) * (x - 3) / 2;
      this.h3[i] = x * (x - 1) * (x - 2) / 6;
    }

    _target(i) { return this.cfg[i].freq * Math.pow(2, (this.fret[i] + this.bend[i]) / 12); }

    _retune(i, snap) {
      this.tgtF[i] = this._target(i);
      if (snap) {
        this.curF[i] = this.tgtF[i]; this.glide[i] = 0; this.dInc[i] = 0;
        const L = this._coefs(i, this.curF[i]);
        this.dl[i] = this.dEnd[i] = L; this._taps(i, L);
      } else this.glide[i] = 1;
    }

    // ---- playing -------------------------------------------------------------
    /** Pluck string s. fret (optional) sets the stopped fret first. */
    pluck(s, vel, fret, kind) {
      if (s < 0 || s >= this.n) return;
      this.damped[s] = 0; this.vibDepth[s] = 0;
      if (fret != null) this.fret[s] = Math.max(0, Math.min(40, fret | 0));
      this._retune(s, true);
      // the finger or pick touches the string first and kills most of what was ringing
      const base = s * this.BUF, k = 0.3;
      for (let j = 0; j < this.BUF; j++) this.buf[base + j] *= k;
      this.lpS[s] *= k;
      for (let j = 0; j < NAP; j++) this.apZ[s * NAP + j] *= k;
      this._excite(s, vel == null ? 0.8 : vel, kind || this.cfg[s].kind);
    }

    /** Change the stopped fret without re-plucking (slide, hammer-on, pull-off). */
    setFret(s, fret, hammer) {
      if (s < 0 || s >= this.n) return;
      this.fret[s] = Math.max(0, Math.min(40, fret | 0));
      this.tau[s] = 0.004;
      this._retune(s, false);
      if (hammer > 0) {
        if (this.damped[s]) { this.damped[s] = 0; this._retune(s, true); }
        this._excite(s, hammer, 'hammer');
      }
    }

    setBend(s, semis) {
      if (s < 0 || s >= this.n) return;
      this.bend[s] = Math.max(-1, Math.min(4, semis));
      this.tau[s] = 0.008;
      this._retune(s, false);
    }

    /** Vibrato: a slow pitch wobble of +-depth semitones that fades in after
     *  a delay. depth 0 stops it and lets the note settle back in tune. */
    setVibrato(s, depth, rate, delay, at) {
      if (s < 0 || s >= this.n) return;
      this.vibDepth[s] = Math.max(0, Math.min(1, depth || 0));
      this.vibRate[s] = Math.max(1, Math.min(12, rate || 5.5));
      this.vibStart[s] = (at == null ? this.now : at) + (delay || 0);
      this.vibPhase[s] = 0;
      if (!this.vibDepth[s]) { this.tau[s] = 0.01; this._retune(s, false); }
    }

    /** Mute a string with the hand. The hand lifts again after a moment, so
     *  the string is free to ring in sympathy afterwards. */
    damp(s) {
      if (s < 0 || s >= this.n) return;
      this.dampUntil[s] = this.now + 0.3;
      if (this.damped[s]) return;
      this.damped[s] = 1;
      const L = this._coefs(s, this.curF[s]);
      if (!this.glide[s]) { this.dl[s] = this.dEnd[s] = L; this._taps(s, L); }
    }

    _excite(i, vel, kind) {
      const sr = this.sr, f = this.curF[i], period = sr / f, tmp = this.tmp, size = this.BUF;
      vel = Math.min(1, Math.max(0.02, vel));
      let widthMs, noise, beta;
      if (kind === 'pick') {              // metal thumb ring: narrow, bright, close to the bridge
        widthMs = 0.15 + 0.32 * (1 - vel); noise = 0.2; beta = 0.115 + 0.03 * this._rand();
      } else if (kind === 'hammer') {     // finger landing on the fret
        widthMs = 0.8; noise = 0; beta = 0;
      } else {                            // fingertip: wider contact, softer, further along the string
        const low = Math.min(2.6, Math.max(0, Math.log2(262 / f)));
        widthMs = (0.4 + 0.7 * (1 - vel)) * (1 + 0.5 * low); noise = 0.035; beta = 0.19 + 0.05 * this._rand();
      }
      const wS = Math.max(2, widthMs * sr / 1000);
      const A = Math.pow(vel, 1.35) * (this.cfg[i].gain || 1) * (0.97 + 0.06 * this._rand());
      // pulse area chosen so loudness stays even from the lowest to the highest note
      const area = 0.125 * A * sr * Math.pow(1 / f, 0.75) * Math.pow(1 / 440, 0.25);
      const pk = area / (wS / 2);
      let len = Math.ceil(wS);
      const nl = noise > 0 ? Math.floor(0.004 * sr) : 0, tauN = 0.0007 * sr;
      const M = beta > 0 ? Math.max(1, Math.round(beta * period)) : 0;
      const total = Math.min(size, Math.max(len, nl) + M);
      for (let k = 0; k < total; k++) {
        let v = k < len ? pk * 0.5 * (1 - Math.cos(TWO_PI * k / wS)) : 0;
        if (k < nl) v += pk * noise * (2 * this._rand() - 1) * Math.exp(-k / tauN);
        tmp[k] = v;
      }
      const base = i * size;
      // pick-position comb: nulls the harmonics that have a node under the pick
      for (let k = 0; k < total; k++) this.exc[base + k] = tmp[k] - (M && k >= M ? 0.97 * tmp[k - M] : 0);
      this.excPos[i] = 0; this.excLen[i] = total;
      this.asleep = false; this.quiet = 0;
    }

    // ---- messages ------------------------------------------------------------
    handle(m) {
      if (m.time != null && m.time > this.now) {
        const q = this.queue; let k = q.length;
        q.push(m);
        while (k > 0 && q[k - 1].time > m.time) { q[k] = q[k - 1]; k--; }
        q[k] = m;
      } else this._apply(m);
    }

    _apply(m) {
      switch (m.type) {
        case 'pluck': this.pluck(m.s, m.vel, m.fret, m.kind); break;
        case 'fret': this.setFret(m.s, m.fret, m.hammer || 0); break;
        case 'bend': this.setBend(m.s, m.semis); break;
        case 'vib': this.setVibrato(m.s, m.depth, m.rate, m.delay, m.time); break;
        case 'damp': this.damp(m.s); break;
        case 'dampAll': for (let i = 0; i < this.n; i++) this.damp(i); break;
        case 'flush': this.queue.length = 0; break;
        case 'resonance': this.setResonance(m.value); break;
        case 'master': this.master = m.value; break;
      }
    }

    reset() {
      this.buf.fill(0); this.lpS.fill(0); this.apZ.fill(0); this.Y.fill(0);
      this.mz1.fill(0); this.mz2.fill(0); this.hpL = this.hpR = 0;
      this.excLen.fill(0); this.excPos.fill(0);
    }

    /** Peak amplitude of each string over its last period. */
    levels(out) {
      const size = this.BUF, mask = this.MASK, buf = this.buf;
      let top = 0;
      for (let i = 0; i < this.n; i++) {
        const len = Math.min(size, Math.ceil(this.dl[i]) + 2), base = i * size;
        let m = 0;
        for (let k = 1; k <= len; k++) { const v = Math.abs(buf[base + ((this.w - k) & mask)]); if (v > m) m = v; }
        out[i] = m; if (m > top) top = m;
      }
      return top;
    }

    /** Wave energy stored in the strings, weighted by impedance (for tests). */
    energy() {
      const size = this.BUF, mask = this.MASK, buf = this.buf;
      let e = 0;
      for (let i = 0; i < this.n; i++) {
        const len = Math.min(size, Math.round(this.dl[i])), base = i * size;
        let s = 0;
        for (let k = 1; k <= len; k++) { const v = buf[base + ((this.w - k) & mask)]; s += v * v; }
        e += this.cfg[i].z * s;
      }
      return e;
    }

    // ---- audio ---------------------------------------------------------------
    process(outL, outR, n, now) {
      this.now = now;
      const q = this.queue;
      if (q.length) {
        const tEnd = now + n / this.sr;
        let k = 0;
        while (k < q.length && q[k].time < tEnd) this._apply(q[k++]);
        if (k) q.splice(0, k);
      }
      if (this.asleep) { outL.fill(0, 0, n); if (outR !== outL) outR.fill(0, 0, n); return; }

      const N = this.n, size = this.BUF, mask = this.MASK, buf = this.buf;
      const dl = this.dl, dInc = this.dInc, di = this.di, h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3;
      const lpB = this.lpB, lpP = this.lpP, lpS = this.lpS, apA = this.apA, apZ = this.apZ;
      const Y = this.Y, cA = this.cA, wL = this.wL, wR = this.wR;
      const exc = this.exc, excPos = this.excPos, excLen = this.excLen;
      const M = this.nm, mb = this.mb, ma1 = this.ma1, ma2 = this.ma2, mz1 = this.mz1, mz2 = this.mz2;
      const mgL = this.mgL, mgR = this.mgR, hpK = this.hpK, master = this.master;

      // pitch glides (slides, bends, hammer-ons): move the delay length smoothly
      for (let i = 0; i < N; i++) {
        if (this.damped[i] && now > this.dampUntil[i]) {
          this.damped[i] = 0;
          const Lr = this._coefs(i, this.curF[i]);
          if (!this.glide[i]) { dl[i] = this.dEnd[i] = Lr; this._taps(i, Lr); }
        }
        if (this.vibDepth[i] > 0 && now >= this.vibStart[i]) {
          const env = Math.min(1, (now - this.vibStart[i]) / 0.3);
          this.vibPhase[i] += TWO_PI * this.vibRate[i] * n / this.sr;
          const fv = this._target(i) * Math.pow(2, this.vibDepth[i] * env * Math.sin(this.vibPhase[i]) / 12);
          this.curF[i] = fv; this.glide[i] = 0;
          this.dEnd[i] = this._coefs(i, fv);
          dInc[i] = (this.dEnd[i] - dl[i]) / n;
          continue;
        }
        if (!this.glide[i]) continue;
        const t = this.tgtF[i];
        let f = this.curF[i];
        f += (t - f) * (1 - Math.exp(-n / (this.sr * this.tau[i])));
        if (Math.abs(t - f) < t * 1e-5) { f = t; this.glide[i] = 0; }
        this.curF[i] = f;
        this.dEnd[i] = this._coefs(i, f);
        dInc[i] = (this.dEnd[i] - dl[i]) / n;
      }

      let w = this.w, hpL = this.hpL, hpR = this.hpR, peak = this.peakPre, peakS = this.peakString;
      for (let k = 0; k < n; k++) {
        let vb = 0, oL = 0, oR = 0;
        for (let i = 0; i < N; i++) {
          if (dInc[i] !== 0) { dl[i] += dInc[i]; this._taps(i, dl[i]); }
          const base = i * size, r = w - di[i];
          const x = h0[i] * buf[base + ((r + 1) & mask)] + h1[i] * buf[base + (r & mask)]
            + h2[i] * buf[base + ((r - 1) & mask)] + h3[i] * buf[base + ((r - 2) & mask)];
          let y = lpB[i] * x + lpP[i] * lpS[i];
          lpS[i] = y;
          const a = apA[i], j = i * NAP;
          let t = a * y + apZ[j]; apZ[j] = y - a * t; y = t;
          t = a * y + apZ[j + 1]; apZ[j + 1] = y - a * t; y = t;
          t = a * y + apZ[j + 2]; apZ[j + 2] = y - a * t; y = t;
          t = a * y + apZ[j + 3]; apZ[j + 3] = y - a * t; y = t;
          Y[i] = y;
          vb += cA[i] * y; oL += wL[i] * y; oR += wR[i] * y;
        }
        for (let i = 0; i < N; i++) {
          let v = Y[i] - vb;
          if (excPos[i] < excLen[i]) v += exc[i * size + excPos[i]++];
          buf[i * size + w] = v;
          const av = v < 0 ? -v : v; if (av > peakS) peakS = av;
        }
        w = (w + 1) & mask;

        // soundbox: resonant modes driven by the summed bridge signal, plus the
        // direct string sound with the lows rolled off
        const m = 0.5 * (oL + oR);
        let bL = 0, bR = 0;
        for (let j = 0; j < M; j++) {
          const b = mb[j] * m, yv = b + mz1[j];
          mz1[j] = mz2[j] - ma1[j] * yv; mz2[j] = -b - ma2[j] * yv;
          bL += mgL[j] * yv; bR += mgR[j] * yv;
        }
        hpL += hpK * (oL - hpL); hpR += hpK * (oR - hpR);
        let L = master * (0.5 * (oL - hpL) + bL), R = master * (0.5 * (oR - hpR) + bR);
        const aL = L < 0 ? -L : L, aR = R < 0 ? -R : R;
        if (aL > peak) peak = aL; if (aR > peak) peak = aR;
        // soft clip so the output is bounded whatever happens upstream
        L = L > 1.5 ? 1 : L < -1.5 ? -1 : L - L * L * L * (4 / 27);
        R = R > 1.5 ? 1 : R < -1.5 ? -1 : R - R * R * R * (4 / 27);
        outL[k] = L; outR[k] = R;
      }
      this.w = w; this.hpL = hpL; this.hpR = hpR; this.peakPre = peak; this.peakString = peakS;

      for (let i = 0; i < N; i++) {
        if (dInc[i] !== 0) { dl[i] = this.dEnd[i]; this._taps(i, dl[i]); dInc[i] = 0; }
      }

      this.reportCount += n;
      if (this.reportCount >= this.reportEvery) {
        this.reportCount = 0;
        const lv = new Float32Array(N);
        const top = this.levels(lv);
        let pending = false;
        for (let i = 0; i < N; i++) if (excPos[i] < excLen[i]) { pending = true; break; }
        if (top < 1e-6 && !pending) {
          if (++this.quiet >= 3) { this.reset(); this.asleep = true; }
        } else this.quiet = 0;
        if (this.onReport) this.onReport(lv, top);
      }
    }
  }

  root.ZitherEngine = ZitherEngine;

  if (typeof registerProcessor === 'function') {
    class ZitherProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.engine = new ZitherEngine(sampleRate, options.processorOptions);
        this.blocks = 0;
        this.engine.onReport = (lv, top) => this.port.postMessage({ type: 'lv', lv, top, blocks: this.blocks });
        this.port.onmessage = (e) => this.engine.handle(e.data);
      }
      process(inputs, outputs) {
        const o = outputs[0];
        this.blocks++;
        this.engine.process(o[0], o[1] || o[0], o[0].length, currentTime);
        return true;
      }
    }
    registerProcessor('zither', ZitherProcessor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
