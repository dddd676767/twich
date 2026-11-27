import Hls from 'hls.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import './VideoPlayer.css'

const MEDIAMTX_WEBRTC_BASE =
  import.meta.env.VITE_MEDIAMTX_WEBRTC_URL ?? '/mtx-webrtc'
const MEDIAMTX_HLS_BASE =
  import.meta.env.VITE_MEDIAMTX_HLS_URL ?? '/mtx-hls'

type PlayerState = 'connecting' | 'live' | 'offline' | 'publishing'
type PlayProtocol = 'webrtc' | 'hls'

type VideoPlayerProps = {
  streamPath: string
}

async function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 500) {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, timeoutMs)
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', onStateChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onStateChange)
  })
}

export function VideoPlayer({ streamPath }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<PlayerState>('connecting')
  const [protocol, setProtocol] = useState<PlayProtocol>('webrtc')
  const [attempt, setAttempt] = useState(0)
  const [isPublishing, setIsPublishing] = useState(false)
  const [shareError, setShareError] = useState('')
  const [showObsGuide, setShowObsGuide] = useState(false)
  const [copiedField, setCopiedField] = useState<'server' | 'key' | null>(null)

  const publishPcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)

  const retry = useCallback(() => {
    setAttempt((n) => n + 1)
  }, [])

  const copyValue = useCallback(async (field: 'server' | 'key', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(field)
      window.setTimeout(() => setCopiedField(null), 1800)
    } catch {
      // Ignore clipboard errors
    }
  }, [])

  const stopPublishing = useCallback(() => {
    if (publishPcRef.current) {
      publishPcRef.current.close()
      publishPcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setIsPublishing(false)
    setAttempt((n) => n + 1)
  }, [])

  const startScreenShare = useCallback(async () => {
    setShareError('')
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setShareError(
        'Браузер не поддерживает захват экрана (откройте сайт через http://localhost:5173)'
      )
      return
    }

    const displayConstraints: DisplayMediaStreamOptions = {
      video: {
        displaySurface: 'monitor',
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 60 },
      } as MediaTrackConstraints,
      audio: true,
    }

    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setShareError('Захват экрана отменён')
        return
      }
      try {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: displayConstraints.video,
          audio: false,
        })
      } catch (fallbackErr) {
        setShareError(
          fallbackErr instanceof Error
            ? `Не удалось захватить экран: ${fallbackErr.message}`
            : 'Не удалось захватить экран'
        )
        return
      }
    }

    const [videoTrack] = mediaStream.getVideoTracks()
    if (videoTrack) {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = 'detail'
      }
      videoTrack.onended = () => {
        stopPublishing()
      }
    }

    localStreamRef.current = mediaStream
    if (videoRef.current) {
      videoRef.current.srcObject = mediaStream
      videoRef.current.play().catch(() => {})
    }

    const pc = new RTCPeerConnection()
    publishPcRef.current = pc
    mediaStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, mediaStream)
      if (track.kind === 'video') {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 4_000_000
        sender.setParameters(params).catch(() => {})
      }
    })

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGathering(pc)

      const whipUrl = `${MEDIAMTX_WEBRTC_BASE}/${streamPath}/whip`
      const res = await fetch(whipUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp ?? offer.sdp,
      })

      if (!res.ok) {
        throw new Error(`MediaMTX вернул статус ${res.status}`)
      }

      const answerSdp = await res.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      setIsPublishing(true)
      setState('publishing')
    } catch (err) {
      stopPublishing()
      setShareError(
        err instanceof Error
          ? `Ошибка публикации: ${err.message}. Убедитесь, что MediaMTX запущен.`
          : 'Не удалось запустить стрим экрана'
      )
    }
  }, [streamPath, stopPublishing])

  useEffect(() => {
    if (!isPublishing || !localStreamRef.current || !videoRef.current) return
    if (videoRef.current.srcObject !== localStreamRef.current) {
      videoRef.current.srcObject = localStreamRef.current
    }
    videoRef.current.play().catch(() => {})
  }, [isPublishing])

  useEffect(() => {
    return () => {
      if (publishPcRef.current) {
        publishPcRef.current.close()
        publishPcRef.current = null
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop())
        localStreamRef.current = null
      }
    }
  }, [streamPath])

  useEffect(() => {
    if (isPublishing) return

    let cancelled = false
    let pc: RTCPeerConnection | null = null
    let hls: Hls | null = null
    let retryTimer: number | undefined

    const scheduleRetry = () => {
      if (retryTimer !== undefined) return
      retryTimer = window.setTimeout(() => {
        if (!cancelled) setAttempt((n) => n + 1)
      }, 3000)
    }

    if (protocol === 'hls') {
      setState('connecting')
      const video = videoRef.current
      const hlsUrl = `${MEDIAMTX_HLS_BASE}/${streamPath}/index.m3u8`

      if (video) {
        video.srcObject = null
        if (Hls.isSupported()) {
          hls = new Hls({ lowLatencyMode: true })
          hls.loadSource(hlsUrl)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return
            setState('live')
            video.play().catch(() => {})
          })
          hls.on(Hls.Events.ERROR, (_ev, data) => {
            if (cancelled || !data.fatal) return
            setState('offline')
            hls?.destroy()
            hls = null
            scheduleRetry()
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = hlsUrl
          video.onloadedmetadata = () => {
            if (cancelled) return
            setState('live')
            video.play().catch(() => {})
          }
          video.onerror = () => {
            if (cancelled) return
            setState('offline')
            scheduleRetry()
          }
        }
      }

      return () => {
        cancelled = true
        if (retryTimer !== undefined) window.clearTimeout(retryTimer)
        if (hls) hls.destroy()
        if (videoRef.current && !publishPcRef.current) {
          videoRef.current.removeAttribute('src')
          videoRef.current.load()
        }
      }
    }

    const startWebRTC = async () => {
      setState('connecting')
      pc = new RTCPeerConnection()
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })

      const remoteStream = new MediaStream()

      pc.ontrack = (event) => {
        if (cancelled) return
        remoteStream.addTrack(event.track)

        const video = videoRef.current
        if (video) {
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream
          }
          video.play().catch(() => {})
        }

        if (event.track.kind === 'video') {
          setState('live')
          event.track.onunmute = () => {
            if (!cancelled) {
              setState('live')
              videoRef.current?.play().catch(() => {})
            }
          }
        }
      }

      const handleDisconnect = () => {
        if (cancelled || !pc) return
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed' ||
          pc.iceConnectionState === 'failed' ||
          pc.iceConnectionState === 'disconnected'
        ) {
          setState('offline')
          scheduleRetry()
        }
      }

      pc.onconnectionstatechange = handleDisconnect
      pc.oniceconnectionstatechange = handleDisconnect

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGathering(pc)

        const whepUrl = `${MEDIAMTX_WEBRTC_BASE}/${streamPath}/whep`
        const res = await fetch(whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription?.sdp ?? offer.sdp,
        })

        if (!res.ok) {
          throw new Error(`WHEP status ${res.status}`)
        }

        const answerSdp = await res.text()
        if (cancelled) return
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      } catch {
        if (cancelled) return
        pc.close()
        pc = null
        if (videoRef.current && !publishPcRef.current) {
          videoRef.current.srcObject = null
        }
        setState('offline')
        scheduleRetry()
      }
    }

    startWebRTC()

    return () => {
      cancelled = true
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
      }
      if (pc) {
        pc.close()
      }
      if (videoRef.current && !publishPcRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [streamPath, attempt, isPublishing, protocol])

  const slashIdx = streamPath.indexOf('/')
  const rtmpApp = slashIdx > 0 ? streamPath.slice(0, slashIdx) : 'live'
  const streamKey = slashIdx > 0 ? streamPath.slice(slashIdx + 1) : streamPath
  const rtmpUrl = `rtmp://127.0.0.1:1935/${rtmpApp}`

  const badgeText =
    state === 'publishing'
      ? 'LIVE · ЭКРАН'
      : state === 'live'
        ? `LIVE · ${protocol.toUpperCase()}`
        : state === 'connecting'
          ? 'CONNECTING'
          : 'OFFLINE'

  return (
    <div className="player-wrapper">
      <div className="player-stage">
        <video
          ref={videoRef}
          className="player-video"
          autoPlay
          playsInline
          controls={!isPublishing}
          muted
        />

        {state !== 'live' && state !== 'publishing' && (
          <div className="player-overlay">
            <div className="player-overlay-box">
              <p className="player-overlay-title">
                {state === 'connecting' ? 'Подключение к эфиру...' : 'Поток офлайн'}
              </p>
              <p className="player-overlay-sub">
                Канал: <code>{streamPath}</code>
              </p>
              <div className="player-overlay-actions">
                <button type="button" className="player-retry-btn" onClick={retry}>
                  Повторить сейчас
                </button>
                <button
                  type="button"
                  className="player-cam-btn"
                  onClick={startScreenShare}
                >
                  Стримить экран
                </button>
              </div>
            </div>
          </div>
        )}

        <span className={`player-badge player-badge--${state}`}>{badgeText}</span>
      </div>

      {shareError && <div className="player-cam-error">{shareError}</div>}

      <div className="player-info">
        <div>
          <h2 className="player-stream-name">{streamPath}</h2>
          <p className="player-hint">
            OBS: <code>{rtmpUrl}</code> · Ключ: <code>{streamKey}</code>
          </p>
        </div>

        <div className="player-info-actions">
          {!isPublishing && (
            <div className="protocol-switch" role="group" aria-label="Режим плеера">
              <button
                type="button"
                className={`protocol-btn ${protocol === 'webrtc' ? 'is-active' : ''}`}
                onClick={() => setProtocol('webrtc')}
              >
                WebRTC
              </button>
              <button
                type="button"
                className={`protocol-btn ${protocol === 'hls' ? 'is-active' : ''}`}
                onClick={() => setProtocol('hls')}
                title="Режим HLS совместим с любыми настройками OBS и работает через Dev Tunnels"
              >
                HLS (OBS)
              </button>
            </div>
          )}

          <button
            type="button"
            className="player-obs-btn"
            onClick={() => setShowObsGuide((v) => !v)}
          >
            {showObsGuide ? 'Скрыть OBS' : 'Настройка OBS'}
          </button>

          {isPublishing ? (
            <button
              type="button"
              className="player-stop-btn"
              onClick={stopPublishing}
            >
              Остановить стрим
            </button>
          ) : (
            <button
              type="button"
              className="player-cam-btn"
              onClick={startScreenShare}
            >
              Стримить экран
            </button>
          )}
        </div>
      </div>

      {showObsGuide && (
        <div className="obs-guide">
          <h3>Подключение OBS Studio к каналу {streamPath}</h3>
          <ol className="obs-steps">
            <li>Откройте в OBS: <strong>Настройки → Вещание → Сервис: Настраиваемый</strong>.</li>
            <li>
              <strong>Сервер:</strong> <code>{rtmpUrl}</code>{' '}
              <button
                type="button"
                className="obs-copy-btn"
                onClick={() => copyValue('server', rtmpUrl)}
              >
                {copiedField === 'server' ? 'Скопировано' : 'Копировать'}
              </button>
            </li>
            <li>
              <strong>Ключ потока:</strong> <code>{streamKey}</code>{' '}
              <button
                type="button"
                className="obs-copy-btn"
                onClick={() => copyValue('key', streamKey)}
              >
                {copiedField === 'key' ? 'Скопировано' : 'Копировать'}
              </button>
            </li>
            <li>
              Если видео в WebRTC не появляется или замирает: в OBS в разделе <strong>Вывод</strong>{' '}
              поставьте <strong>B-кадры = 0</strong> (или переключите плеер выше в режим{' '}
              <strong>HLS (OBS)</strong> — в нём работают любые настройки и просмотр через Dev Tunnels).
            </li>
          </ol>
        </div>
      )}
    </div>
  )
}
