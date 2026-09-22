/**
 * Type element strike and margin bell, synthesised.
 *
 * Off until the operator asks for it: browsers will not start an AudioContext
 * without a gesture, and a machine that starts clattering unannounced is worse
 * than a silent one.
 */
export class Sound {
  enabled = false;

  #context = null;

  toggle(on) {
    this.enabled = on ?? !this.enabled;
    if (this.enabled && !this.#context) {
      this.#context = new (window.AudioContext || window.webkitAudioContext)();
    }
    this.#context?.resume();
    return this.enabled;
  }

  /** A type element hitting the platen: a short filtered noise burst. */
  strike(char) {
    const ctx = this.#ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    const length = Math.floor(ctx.sampleRate * 0.03);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    // A space is the carrier moving without a strike: duller and quieter.
    filter.frequency.value = char === ' ' ? 900 : 1900 + Math.random() * 500;
    filter.Q.value = 1.4;

    const gain = ctx.createGain();
    gain.gain.value = char === ' ' ? 0.05 : 0.14;

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(now);
  }

  /** The signal bell, twelve positions from the right margin. */
  bell() {
    const ctx = this.#ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [frequency, level] of [[2100, 0.09], [3150, 0.04]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(level, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    }
  }

  #ready() {
    return this.enabled && this.#context?.state === 'running' ? this.#context : null;
  }
}
