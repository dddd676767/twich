import React, { useEffect, useState } from 'react'
import { login, me, register, type User } from './api'
import { Chat } from './components/Chat'
import { VideoPlayer } from './components/VideoPlayer'
import { useStreams } from './hooks/useStreams'
import './App.css'

type Mode = 'login' | 'register'

function App() {
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'))
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [activeStream, setActiveStream] = useState('live/stream')
  const [customStream, setCustomStream] = useState('live/stream')
  const { streams, apiAvailable } = useStreams(3000)

  // если есть сохраненные токены проверяем их через /me
  useEffect(() => {
    if (!token) {
      setUser(null)
      return
    }
    me()
      .then(setUser)
      .catch(() => {
        localStorage.removeItem('token')
        setToken(null)
      })
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (mode === 'register') {
        await register(email, password)
        setNotice('Аккаунт создан, входим')
      }
      const { access_token } = await login(email, password)
      localStorage.setItem('token', access_token)
      setToken(access_token)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Произошла ошибка')
    } finally {
      setBusy(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
    setPassword('')
  }

  const handleSelectStream = (name: string) => {
    const normalized = name.trim().replace(/^\/+|\/+$/g, '')
    if (!normalized) return
    setActiveStream(normalized)
    setCustomStream(normalized)
  }

  const submitCustomStream = (e: React.FormEvent) => {
    e.preventDefault()
    handleSelectStream(customStream)
  }

  if (token && !user) return <div className="auth-checking">Проверяем токен...</div>

  if (token && user) {
    return (
      <div className="stream-app">
        <header className="topbar">
          <div className="topbar-left">
            <span className="brand">STREAM</span>

            <form className="stream-switcher" onSubmit={submitCustomStream}>
              <input
                type="text"
                className="stream-switcher-input"
                value={customStream}
                onChange={(e) => setCustomStream(e.target.value)}
                placeholder="live/stream"
                aria-label="Путь стрима"
              />
              <button type="submit" className="stream-switcher-btn">
                Открыть
              </button>
            </form>

            {streams.length > 0 && (
              <div className="live-pills" aria-label="Активные стримы">
                {streams.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className={`live-pill ${activeStream === s.name ? 'is-active' : ''}`}
                    onClick={() => handleSelectStream(s.name)}
                  >
                    <span className={`live-dot ${s.ready ? 'is-ready' : ''}`} />
                    {s.name} ({s.readersCount})
                  </button>
                ))}
              </div>
            )}
            {!apiAvailable && (
              <span className="mediamtx-warn" title="Запустите .\start-mediamtx.ps1">
                MediaMTX API недоступен
              </span>
            )}
          </div>

          <div className="topbar-right">
            <span className="user-email">{user.email}</span>
            <button type="button" className="logout-btn" onClick={logout}>
              Выйти
            </button>
          </div>
        </header>

        <main className="twitch-layout">
          <div className="twitch-stage">
            <VideoPlayer streamPath={activeStream} />
          </div>
          <div className="twitch-chat">
            <Chat token={token} currentUser={user} room={activeStream} />
          </div>
        </main>
      </div>
    )
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <h1>STREAM</h1>
      <div className="auth-tabs">
        <button
          type="button"
          className={mode === 'login' ? 'active' : ''}
          onClick={() => {
            setMode('login')
            setError('')
            setNotice('')
          }}
        >
          Вход
        </button>
        <button
          type="button"
          className={mode === 'register' ? 'active' : ''}
          onClick={() => {
            setMode('register')
            setError('')
            setNotice('')
          }}
        >
          Регистрация
        </button>
      </div>

      <label>Email</label>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="введите email"
      />
      <label>Пароль</label>
      <input
        type="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="введите пароль"
      />

      <button className="submit" disabled={busy}>
        {busy ? 'подожди...' : mode === 'login' ? 'Войти' : 'создать аккаунт'}
      </button>
      {error && <div className="auth-error">{error}</div>}
      {notice && !error && <div className="auth-notice">{notice}</div>}
    </form>
  )
}

export default App
