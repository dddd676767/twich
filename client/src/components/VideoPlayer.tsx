import { useCallback, useEffect, useRef, useState } from 'react'
import './VideoPlayer.css'

const MEDIAMTX_WEBRTC_BASE =
  import.meta.env.VITE_MEDIAMTX_WEBRTC_URL ?? 'http://127.0.0.1:8889'

type PlayerState = 'connecting' | 'live' | 'offline' | 'publishing'

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
  const [attempt, setAttempt] = useState(0)
  const [isPublishing, setIsPublishing] = useState(false)
  const [shareError, setShareError] = useState('')

  const publishPcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)

  const retry = useCallback(() => {
    setAttempt((n) => n + 1)
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
      // Пользователь отменил выбор экрана или браузер отклонил audio
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
      // Приоритет чёткости текста и деталей интерфейса при кодировании WebRTC
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
        params.encodings[0].maxBitrate = 4_000_000 // 4 Mbps для чёткой картинки экрана
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

  // Гарантируем, что при активной публикации <video> всегда показывает локальный экран
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
    let retryTimer: number | undefined

    const startWebRTC = async () => {
      setState('connecting')
      pc = new RTCPeerConnection()
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })

      pc.ontrack = (event) => {
        if (cancelled) return
        const video = videoRef.current
        if (video && event.streams[0]) {
          video.srcObject = event.streams[0]
          video.play().catch(() => {})
          setState('live')
        }
      }

      pc.onconnectionstatechange = () => {
        if (cancelled || !pc) return
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          setState('offline')
          retryTimer = window.setTimeout(() => {
            if (!cancelled) setAttempt((n) => n + 1)
          }, 3000)
        }
      }

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
        retryTimer = window.setTimeout(() => {
          if (!cancelled) setAttempt((n) => n + 1)
        }, 3000)
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
  }, [streamPath, attempt, isPublishing])

  const rtmpUrl = 'rtmp://127.0.0.1:1935/live'
  const streamKey = streamPath.startsWith('live/')
    ? streamPath.slice('live/'.length)
    : streamPath

  const badgeText =
    state === 'publishing'
      ? 'LIVE · ЭКРАН'
      : state === 'live'
        ? 'LIVE'
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
    </div>
  )
}
