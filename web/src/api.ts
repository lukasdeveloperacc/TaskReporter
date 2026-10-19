import type { StateSnapshot } from '../../shared/contract.ts'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('관제실 서버에 연결할 수 없습니다. 서버 상태를 확인해 주세요.')
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail || `요청에 실패했습니다 (${response.status}).`)
  }
  return response.json() as Promise<T>
}

export function getState(): Promise<StateSnapshot> {
  return request<StateSnapshot>('/api/state')
}

export function answerAsk(id: string, answer: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/asks/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer }),
  })
}

export function getDoc(runId: string): Promise<{ path: string; text: string }> {
  return request<{ path: string; text: string }>(`/api/runs/${encodeURIComponent(runId)}/doc`)
}

export function subscribe(
  onChanged: () => void,
  onDocChanged: (event: { run_id: string; path: string }) => void,
  onReconnect?: () => void,
): () => void {
  const source = new EventSource('/api/events')
  let opened = false
  source.addEventListener('open', () => {
    if (opened) onReconnect?.()
    opened = true
    onChanged()
  })
  source.addEventListener('changed', onChanged)
  source.addEventListener('doc-changed', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent<string>).data) as { run_id?: unknown; path?: unknown }
      if (typeof data.run_id === 'string' && typeof data.path === 'string') {
        onDocChanged({ run_id: data.run_id, path: data.path })
      }
    } catch {
      // Ignore malformed events; the next state refresh remains authoritative.
    }
  })
  return () => source.close()
}
