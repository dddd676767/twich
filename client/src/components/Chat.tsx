import React, { useEffect, useRef, useState } from 'react'
import type { User } from '../api'
import './Chat.css'

export type ChatMessage = {
  id: string
  room: string
  userId: number
  email: string
  text: string
  createdAt: string
}

type WsInbound =
  | { type: 'history'; room: string; messages: ChatMessage[]; onlineCount?: number }
  | { type: 'message'; room: string; message: ChatMessage }
  | { type: 'presence'; room: string; onlineCount: number }
  | { type: 'error'; error: string }

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const CHAT_WS_BASE =
  import.meta.env.VITE_CHAT_WS_URL ??
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`

type ChatProps = {
  token: string
  currentUser: User
  room: string
}

export function Chat({ token, currentUser, room }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [onlineCount, setOnlineCount] = useState(0)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const listEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    let closedByUser = false
    let reconnectTimer: number | undefined

    const connect = () => {
      setStatus('connecting')
      setError('')

      const url = `${CHAT_WS_BASE}?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (closedByUser || wsRef.current !== ws) return
        setStatus('connected')
        setError('')
      }

      ws.onmessage = (event) => {
        if (closedByUser || wsRef.current !== ws) return
        try {
          const payload = JSON.parse(event.data) as WsInbound
          if (payload.type === 'history') {
            setMessages(payload.messages ?? [])
            if (typeof payload.onlineCount === 'number') {
              setOnlineCount(payload.onlineCount)
            }
          } else if (payload.type === 'message') {
            setMessages((prev) => [...prev, payload.message])
          } else if (payload.type === 'presence') {
            setOnlineCount(payload.onlineCount)
          } else if (payload.type === 'error') {
            setError(payload.error)
          }
        } catch {
          // Ignore malformed frames
        }
      }

      ws.onerror = () => {
        if (closedByUser || wsRef.current !== ws) return
        setError('Не удалось подключиться к Go-серверу чата')
      }

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null
          setStatus('disconnected')
        }
        if (!closedByUser) {
          reconnectTimer = window.setTimeout(connect, 2500)
        }
      }
    }

    setMessages([])
    setOnlineCount(0)
    connect()

    return () => {
      closedByUser = true
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
      }
      wsRef.current?.close()
    }
  }, [room, token])

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return

    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Нет соединения с сервером чата')
      return
    }

    setError('')
    ws.send(JSON.stringify({ type: 'message', text: trimmed }))
    setText('')
  }

  const formatTime = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const statusLabel =
    status === 'connected'
      ? `В чате: ${onlineCount}`
      : status === 'connecting'
        ? 'Подключение...'
        : 'Переподключение...'

  return (
    <aside className="chat-card" aria-label="Чат стрима">
      <header className="chat-header">
        <div>
          <h2 className="chat-title">Чат стрима</h2>
          <span className="chat-room-label">{room}</span>
        </div>
        <span className={`chat-status chat-status--${status}`}>{statusLabel}</span>
      </header>

      <div className="chat-messages">
        {messages.length === 0 ? (
          <p className="chat-empty">Сообщений пока нет. Напишите стримеру первым!</p>
        ) : (
          messages.map((msg) => {
            const isOwn = msg.userId === currentUser.id
            const shortName = msg.email.split('@')[0] || msg.email
            return (
              <div key={msg.id} className={`chat-msg ${isOwn ? 'chat-msg--own' : ''}`}>
                <span className="chat-msg-time">{formatTime(msg.createdAt)}</span>{' '}
                <span className="chat-msg-author" title={msg.email}>
                  {shortName}:
                </span>{' '}
                <span className="chat-msg-text">{msg.text}</span>
              </div>
            )
          })
        )}
        <div ref={listEndRef} />
      </div>

      {error && <div className="chat-error">{error}</div>}

      <form className="chat-form" onSubmit={sendMessage}>
        <input
          type="text"
          className="chat-input"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="Отправить сообщение в чат..."
          disabled={status !== 'connected'}
        />
        <button
          type="submit"
          className="chat-send-btn"
          disabled={status !== 'connected' || !text.trim()}
        >
          Чат
        </button>
      </form>
    </aside>
  )
}
