/**
 * Seeded linear congruential generator. Every stochastic decision in the sim
 * draws from one of these, so a given (seed, input) pair always replays
 * identically. Determinism is a gate in verify.sh, not a nicety.
 */
export class Rng {
  private state: number;
  constructor(seed = 9341) {this.state = seed >>> 0 || 1;}
  next() {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  /** Uniform in [a, b). */
  range(a: number, b: number) {return a + this.next() * (b - a);}
  /** Symmetric about zero, in [-m, m). */
  spread(m: number) {return (this.next() * 2 - 1) * m;}
  int(a: number, b: number) {return Math.floor(this.range(a, b + 1));}
  pick<T>(items: readonly T[]) {return items[Math.floor(this.next() * items.length)];}
}
