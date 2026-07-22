/** Tom de chamando (ringback) — padrão brasileiro 425 Hz, 1s ligado / 4s desligado. */
export class RingbackTone {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.active = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.ctx = new AudioContext();
    this._cycle();
    this.timer = setInterval(() => this._cycle(), 5000);
  }

  _cycle() {
    if (!this.ctx || !this.active) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 425;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 1);
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
