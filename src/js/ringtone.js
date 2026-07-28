/** Toque de chamada recebida — dual-tone (440+480 Hz), 1s ligado / 2s desligado. */
export class IncomingRingtone {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.active = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this._burst();
    this.timer = setInterval(() => this._burst(), 3000);
  }

  _burst() {
    if (!this.ctx || !this.active) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const now = this.ctx.currentTime;
    const duration = 1.0;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.03);
    gain.gain.setValueAtTime(0.22, now + duration - 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    gain.connect(this.ctx.destination);

    [440, 480].forEach((freq) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    });
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
