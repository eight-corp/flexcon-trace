import { useEffect, useRef, useState } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import { Camera, CameraOff } from 'lucide-react'

const SCAN_DELAY_MS = 80
const SCAN_REGION = { top: 0.12, right: 0.16, bottom: 0.12, left: 0.16 }
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

function drawScanRegion(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight
  const displayWidth = video.clientWidth
  const displayHeight = video.clientHeight
  if (!videoWidth || !videoHeight || !displayWidth || !displayHeight) return false

  const coverScale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight)
  const croppedX = (videoWidth * coverScale - displayWidth) / 2
  const croppedY = (videoHeight * coverScale - displayHeight) / 2
  const regionX = displayWidth * SCAN_REGION.left
  const regionY = displayHeight * SCAN_REGION.top
  const regionWidth = displayWidth * (1 - SCAN_REGION.left - SCAN_REGION.right)
  const regionHeight = displayHeight * (1 - SCAN_REGION.top - SCAN_REGION.bottom)

  const sourceX = (croppedX + regionX) / coverScale
  const sourceY = (croppedY + regionY) / coverScale
  const sourceWidth = regionWidth / coverScale
  const sourceHeight = regionHeight / coverScale
  const targetWidth = Math.max(1, Math.round(sourceWidth))
  const targetHeight = Math.max(1, Math.round(sourceHeight))

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return false
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    targetWidth,
    targetHeight,
  )
  return true
}

export function QrScanner({ active, onRead, onStart, onStop }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onReadRef = useRef(onRead)
  const [error, setError] = useState('')

  useEffect(() => { onReadRef.current = onRead }, [onRead])

  useEffect(() => {
    const video = videoRef.current
    if (!active || !video) return

    let disposed = false
    let stream: MediaStream | undefined
    let scanTimer: number | undefined
    const reader = new BrowserQRCodeReader()
    const scanCanvas = document.createElement('canvas')
    setError('')

    const scan = () => {
      if (disposed) return
      if (drawScanRegion(video, scanCanvas)) {
        try {
          const result = reader.decodeFromCanvas(scanCanvas)
          onReadRef.current(result.getText())
        } catch {
          // A frame without a readable QR is expected during continuous scanning.
        }
      }
      scanTimer = window.setTimeout(scan, SCAN_DELAY_MS)
    }

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        video.srcObject = stream
        await video.play()
        scan()
      } catch {
        if (!disposed) {
          setError('カメラを開始できません。カメラの使用を許可してください。')
          onStop()
        }
      }
    }

    void startCamera()

    return () => {
      disposed = true
      if (scanTimer !== undefined) window.clearTimeout(scanTimer)
      video.pause()
      video.srcObject = null
      stream?.getTracks().forEach((track) => track.stop())
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
