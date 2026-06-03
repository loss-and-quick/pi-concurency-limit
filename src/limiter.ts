export type Release = () => void

type Slot = {
  limit: number
  active: number
  queue: Array<() => void>
}

export class Limiter {
  private readonly slots = new Map<string, Slot>()

  acquire(key: string, limit: number): Promise<Release> {
    const slot = this.getOrCreate(key, limit)
    slot.limit = limit

    if (slot.active < slot.limit) {
      slot.active++
      return Promise.resolve(this.makeRelease(key))
    }

    return new Promise<Release>((resolve) => {
      slot.queue.push(() => {
        slot.active++
        resolve(this.makeRelease(key))
      })
    })
  }

  stats(key: string): { active: number; queued: number; limit: number } | undefined {
    const slot = this.slots.get(key)
    if (!slot) return undefined
    return { active: slot.active, queued: slot.queue.length, limit: slot.limit }
  }

  private getOrCreate(key: string, limit: number): Slot {
    let slot = this.slots.get(key)
    if (!slot) {
      slot = { limit, active: 0, queue: [] }
      this.slots.set(key, slot)
    }
    return slot
  }

  private makeRelease(key: string): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      const slot = this.slots.get(key)
      if (!slot) return
      slot.active = Math.max(0, slot.active - 1)
      while (slot.active < slot.limit && slot.queue.length > 0) {
        const next = slot.queue.shift()!
        next()
      }
    }
  }
}
