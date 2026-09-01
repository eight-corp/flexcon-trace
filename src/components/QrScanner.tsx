import { useEffect, useRef, useState } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import { Camera, CameraOff } from 'lucide-react'

const SCAN_DELAY_MS = 80
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  },
}

type Props = {
  active: boolean
  onRead: (value: string) => void
  onStart: () => void
  onStop: () => void
}

export function QrScanner({ active, onRead, onStart, onStop }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onReadRef = useRef(onRead)
  const [error, setError] = useState('')

  useEffect(() => { onReadRef.current = onRead }, [onRead])

  useEffect(() => {
    if (!active || !videoRef.current) return
    let disposed = false
    let stop: (() => void) | undefined
    const reader = new BrowserQRCodeReader(undefined, {
      delayBetweenScanAttempts: SCAN_DELAY_MS,
    })
    setError('')

    void reader.decodeFromConstraints(
      CAMERA_CONSTRAINTS,
      videoRef.current,
      (result) => { if (result && !disposed) onReadRef.current(result.getText()) },
    ).then((controls) => {
      stop = () => controls.stop()
      if (disposed) controls.stop()
    }).catch(() => {
      setError('カメラを開始できません。カメラの使用を許可してください。')
      onStop()
    })

    return () => {
      disposed = true
      stop?.()
    }
  }, [active, onStop])

  return (
    <>
      <div className="scanner-frame">
        {active ? (
          <><video ref={videoRef} muted playsInline aria-label="QRコード読み取りカメラ" /><div className="scanner-reticle" aria-hidden="true" /></>
        ) : (
          <div className="scanner-placeholder"><Camera size={40} /><span>連続読取を開始すると<br />背面カメラが起動します</span></div>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="scan-toolbar">
        {active
          ? <button className="danger-button" type="button" onClick={onStop}><CameraOff size={19} />読取停止</button>
          : <button className="primary-button" type="button" onClick={onStart}><Camera size={19} />連続読取を開始</button>}
      </div>
    </>
  )
}
