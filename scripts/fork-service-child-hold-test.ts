import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ForkItem } from '../src/main/core/ForkItem'

// ForkItem copies the main-process Server snapshot into every initialization message.
;(globalThis as any).Server = {}

class FakeWorker extends EventEmitter {
  pid = 4242
  posted: any[] = []
  postMessage(message: any) {
    this.posted.push(message)
  }
  kill() {
    this.emit('exit')
  }
}

function createItem(options: { dedicated?: boolean } = {}) {
  const worker: any = new FakeWorker()
  let idle: (() => void) | undefined
  const item = new ForkItem(
    'fork.js',
    {
      idleTimeoutMs: 1,
      primary: true,
      dedicated: options.dedicated,
      forkProcess: () => worker as any,
      killProcess: () => {},
      idleScheduler: {
        set: (callback) => {
          idle = callback
          return {} as any
        },
        clear: () => {
          idle = undefined
        }
      }
    },
    {} as any,
    {} as any,
    {} as any,
    () => undefined
  )
  return { worker, item, idle: () => idle }
}

function main() {
  // A job-bound service child keeps its worker out of the idle reaper.
  {
    const { worker, item, idle } = createItem()
    worker.emit('spawn')
    assert.equal(item.isPinned, false)
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9001' })
    assert.equal(item.isPinned, true)

    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9001' })
    assert.equal(item.isPinned, false)
    assert.equal(typeof idle(), 'function')

    // The released worker is reaped again by the next idle turn.
    idle()!()
    assert.equal(item.childExited, true)
  }

  // A new service child cancels the idle pass that the previous exit scheduled.
  {
    const { worker, item, idle } = createItem()
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9101' })
    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9101' })
    assert.equal(typeof idle(), 'function')
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9102' })
    assert.equal(item.isPinned, true)
    assert.equal(idle(), undefined)
  }

  // Late messages from a retired worker are ignored.
  {
    const { worker, item, idle } = createItem()
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9201' })
    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9201' })
    idle()!()
    assert.equal(item.childExited, true)
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9202' })
    assert.equal(item.isPinned, false)
  }

  // The worker outlives every child it started, not just the first one.
  {
    const { worker, item } = createItem()
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9001' })
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9002' })
    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9001' })
    assert.equal(item.isPinned, true)
    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9002' })
    assert.equal(item.isPinned, false)
  }

  // Dedicated plugin workers are pinned by construction and stay pinned.
  {
    const { worker, item } = createItem({ dedicated: true })
    assert.equal(item.isPinned, true)
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '9003' })
    item.onMessage(worker, { type: 'service-child', state: 'exited', pid: '9003' })
    assert.equal(item.isPinned, true)
  }

  // Messages from a retired worker and placeholder PIDs must not pin anything.
  {
    const { worker, item } = createItem()
    item.onMessage(new FakeWorker() as any, {
      type: 'service-child',
      state: 'started',
      pid: '9004'
    })
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '-1' })
    item.onMessage(worker, { type: 'service-child', state: 'started', pid: '' })
    assert.equal(item.isPinned, false)
  }

  console.log('Fork service child hold tests passed')
}

main()
