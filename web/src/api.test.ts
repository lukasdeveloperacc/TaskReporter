// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setProjectVisibility, subscribe } from './api.ts'

class MockEventSource {
  static instances: MockEventSource[] = []
  listeners = new Map<string, EventListener[]>()
  closed = false
  url: string

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() { this.closed = true }

  emit(type: string, event: Event = new Event(type)) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('subscribe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    MockEventSource.instances = []
  })

  it('refreshes state on open, reconnect, and changed events, and forwards document changes', () => {
    vi.stubGlobal('EventSource', MockEventSource)
    const onChanged = vi.fn()
    const onDocChanged = vi.fn()
    const onReconnect = vi.fn()
    const unsubscribe = subscribe(onChanged, onDocChanged, onReconnect)
    const source = MockEventSource.instances[0]

    source.emit('open')
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onReconnect).not.toHaveBeenCalled()
    source.emit('open')
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    source.emit('changed')
    expect(onChanged).toHaveBeenCalledTimes(3)
    source.emit('doc-changed', Object.assign(new Event('doc-changed'), { data: JSON.stringify({ run_id: 'run-1', path: 'docs/plan.md' }) }))
    expect(onDocChanged).toHaveBeenCalledWith({ run_id: 'run-1', path: 'docs/plan.md' })
    unsubscribe()
    expect(source.closed).toBe(true)
  })

  it('ignores malformed document-change payloads', () => {
    vi.stubGlobal('EventSource', MockEventSource)
    const onDocChanged = vi.fn()
    subscribe(vi.fn(), onDocChanged)
    MockEventSource.instances[0].emit('doc-changed', Object.assign(new Event('doc-changed'), { data: '{bad json' }))
    expect(onDocChanged).not.toHaveBeenCalled()
  })
})

describe('setProjectVisibility', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the project path and visibility in a PATCH request', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) })
    vi.stubGlobal('fetch', fetch)

    await expect(setProjectVisibility('/workspace/alpha', true)).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/projects/visibility', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_path: '/workspace/alpha', hidden: true }),
    })
  })

  it('surfaces a server error for retry handling in the lobby', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: vi.fn().mockResolvedValue('project not found') })
    vi.stubGlobal('fetch', fetch)

    await expect(setProjectVisibility('/workspace/missing', false)).rejects.toThrow('project not found')
  })
})
