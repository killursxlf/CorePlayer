/** Keep only the newest drag position while the decoder is seeking. */
export class PreviewSeekQueue {
  private pending: number | null = null

  request(time: number, seeking: boolean, apply: (time: number) => void) {
    this.pending = time
    if (!seeking) this.flush(apply)
  }

  flush(apply: (time: number) => void) {
    const target = this.pending
    this.pending = null
    if (target !== null) apply(target)
  }

  clear() { this.pending = null }
}
