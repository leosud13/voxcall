/** Tom de chamando (ringback) — padrão brasileiro 425 Hz, 1s ligado / 4s desligado. */
export class RingbackTone {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.active = false;
    this.osc = null;
    this.gain = null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this._cycle();
    this.timer = setInterval(() => this._cycle(), 5000);
  }

  _cycle() {
    if (!this.ctx || !this.active) return;
    this._stopOscillator();

    this.osc = this.ctx.createOscillator();
    this.gain = this.ctx.createGain();
    this.osc.type = 'sine';
    this.osc.frequency.value = 425;
    this.gain.gain.value = 0.12;
    this.osc.connect(this.gain);
    this.gain.connect(this.ctx.destination);
    this.osc.start();
    this.osc.stop(this.ctx.currentTime + 1);
  }

  _stopOscillator() {
    if (this.gain && this.ctx) {
      try {
        this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      } catch {
        /* ignore */
      }
    }
    if (this.osc) {
      try {
        this.osc.stop();
        this.osc.disconnect();
      } catch {
        /* already stopped */
      }
      this.osc = null;
    }
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.gain = null;
    }
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._stopOscillator();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
