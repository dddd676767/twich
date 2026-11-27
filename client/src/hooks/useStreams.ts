import { useEffect, useState } from 'react'

export type MediaMTXPath = {
  name: string
  ready: boolean
  readersCount: number
}

const MEDIAMTX_API_BASE = import.meta.env.VITE_MEDIAMTX_API_URL ?? '/mtx-api'

export function useStreams(pollMs = 3000) {
  const [streams, setStreams] = useState<MediaMTXPath[]>([])
  const [apiAvailable, setApiAvailable] = useState(true)

  useEffect(() => {
    let active = true

    const fetchStreams = async () => {
      try {
        const res = await fetch(`${MEDIAMTX_API_BASE}/v3/paths/list`)
        if (!res.ok) throw new Error('MediaMTX API error')
        const data = (await res.json()) as {
          items?: Array<{ name?: string; ready?: boolean; readers?: unknown[] }>
        }
        if (!active) return
        const items = (data.items ?? [])
          .filter((item) => Boolean(item.name))
          .map((item) => ({
            name: item.name as string,
            ready: Boolean(item.ready),
            readersCount: Array.isArray(item.readers) ? item.readers.length : 0,
          }))
        setStreams(items)
        setApiAvailable(true)
      } catch {
        if (!active) return
        setApiAvailable(false)
      }
    }

    fetchStreams()
    const id = window.setInterval(fetchStreams, pollMs)
    return () => {
      active = false
      window.clearInterval(id)
    }
  }, [pollMs])

  return { streams, apiAvailable }
}
