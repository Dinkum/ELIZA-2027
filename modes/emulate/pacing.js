export class MachinePacer {
  constructor(speed, chunk) {
    this.speed = speed;
    this.chunk = chunk;
    this.due = performance.now();
  }

  delay(slots) {
    if (slots === 0) return 10;
    if (!(this.speed > 0)) return 0;

    const now = performance.now();
    const chunkMs = this.chunk * 1000 / this.speed;
    this.due = Math.max(this.due, now - chunkMs) + slots * 1000 / this.speed;
    return Math.max(0, this.due - now);
  }
}
