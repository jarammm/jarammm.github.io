// Pure timeline math for chunked playback. A song of `length` samples is split into chunks of
// `chunkSamples` (the last one shorter). Playback loops forever, so chunks are numbered globally:
// global chunk j is chunk (j mod count) of loop floor(j / count).

export class Timeline {
  /**
   * @param {{sampleRate:number, length:number, chunkSamples:number, chunkCount:number}} t
   */
  constructor({ sampleRate, length, chunkSamples, chunkCount }) {
    if (!(sampleRate > 0 && length > 0 && chunkSamples > 0)) throw new Error("invalid timeline");
    if (chunkCount !== Math.ceil(length / chunkSamples)) {
      throw new Error(`chunk count ${chunkCount} does not cover ${length} samples in chunks of ${chunkSamples}`);
    }
    Object.assign(this, { sampleRate, length, chunkSamples, chunkCount });
    this.duration = length / sampleRate;  // seconds per loop
  }

  /** Local chunk index for global chunk j. */
  local(j) {
    return j % this.chunkCount;
  }

  /** Samples in local chunk k (the last chunk is shorter). */
  chunkLength(k) {
    return Math.min(this.chunkSamples, this.length - k * this.chunkSamples);
  }

  /** Global position (seconds from loop 0, sample 0) where global chunk j starts. Exact sample multiples. */
  chunkStart(j) {
    const loop = Math.floor(j / this.chunkCount);
    return (loop * this.length + this.local(j) * this.chunkSamples) / this.sampleRate;
  }

  /** Global chunk index holding song position p (seconds, within loop 0). */
  chunkAt(p) {
    const s = Math.min(this.length - 1, Math.max(0, Math.floor(p * this.sampleRate)));
    return Math.floor(s / this.chunkSamples);
  }

  /** Song position (seconds in [0, duration)) of a global position. */
  wrap(globalPos) {
    return ((globalPos % this.duration) + this.duration) % this.duration;
  }

  /** Round a context time to the nearest sample frame, so every chunk boundary lands on a frame. */
  frame(t) {
    return Math.round(t * this.sampleRate) / this.sampleRate;
  }
}
