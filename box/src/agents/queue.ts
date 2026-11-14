/** Values pushed in one end and read, in order, from an async iterator at the other. */
export class Queue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiting?: (result: IteratorResult<T>) => void
  private closed = false

  push(item: T) {
    if (this.closed) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close() {
    this.closed = true
    this.waiting?.({ value: undefined as never, done: true })
    this.waiting = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}
