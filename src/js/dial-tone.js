/** Tons DTMF (ITU-T Q.23) para o teclado de discagem. */
const DTMF_FREQS = {
  1: [697, 1209],
  2: [697, 1336],
  3: [697, 1477],
  4: [770, 1209],
  5: [770, 1336],
  6: [770, 1477],
  7: [852, 1209],
  8: [852, 1336],
  9: [852, 1477],
  '*': [941, 1209],
  0: [941, 1336],
  '#': [941, 1477],
  '+': [941, 1633],
};

export class DialTone {
  constructor() {
    this.ctx = null;
  }

  _ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  play(digit) {
    const key = String(digit ?? '');
    const freqs = DTMF_FREQS[key];
    if (!freqs) return;

    try {
      const ctx = this._ensureCtx();
      const now = ctx.currentTime;
      const duration = 0.12;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      gain.connect(ctx.destination);

      freqs.forEach((freq) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + duration + 0.02);
      });
    } catch {
      /* audio optional */
    }
  }
}

export const dialTone = new DialTone();
