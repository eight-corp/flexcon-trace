import { useEffect, useRef, useState } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'
import { Camera, CameraOff } from 'lucide-react'

const SCAN_DELAY_MS = 80
const PREVIEW_WIDTH = 960
const PREVIEW_HEIGHT = 720
const SCAN_REGION = { top: 0.12, right: 0.16, bottom: 0.12, left: 0.16 }
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 960, max: 960 },
    aspectRatio: { ideal: 4 / 3 },
    frameRate: { ideal: 30, max: 30 },
  },
}

type Props = {
  active: boolean
  onRead: (value: string) => void
  onStart: () => void
  onStop: () => void
}

function drawCameraFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return false

  const sourceAspect = sourceWidth / sourceHeight
  const previewAspect = PREVIEW_WIDTH / PREVIEW_HEIGHT
  let sourceX = 0
  let sourceY = 0
  let cropWidth = sourceWidth
  let cropHeight = sourceHeight

  if (sourceAspect > previewAspect) {
    cropWidth = sourceHeight * previewAspect
    sourceX = (sourceWidth - cropWidth) / 2
  } else if (sourceAspect < previewAspect) {
    cropHeight = sourceWidth / previewAspect
    sourceY = (sourceHeight - cropHeight) / 2
  }

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return false
  context.drawImage(
    video,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    PREVIEW_WIDTH,
    PREVIEW_HEIGHT,
  )
  return true
}

function drawScanRegion(preview: HTMLCanvasElement, scanCanvas: HTMLCanvasElement) {
  const sourceX = Math.round(preview.width * SCAN_REGION.left)
  const sourceY = Math.round(preview.height * SCAN_REGION.top)
  const sourceWidth = Math.round(preview.width * (1 - SCAN_REGION.left - SCAN_REGION.right))
  const sourceHeight = Math.round(preview.height * (1 - SCAN_REGION.top - SCAN_REGION.bottom))

  if (scanCanvas.width !== sourceWidth || scanCanvas.height !== sourceHeight) {
    scanCanvas.width = sourceWidth
    scanCanvas.height = sourceHeight
  }
  const context = scanCanvas.getContext('2d', { willReadFrequently: true })
  if (!context) return false
  context.drawImage(preview, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
  return true
}

export function QrScanner({ active, onRead, onStart, onStop }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onReadRef = useRef(onRead)
  const [error, setError] = useState('')

  useEffect(() => { onReadRef.current = onRead }, [onRead])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!active || !video || !canvas) return

    let disposed = false
    let stream: MediaStream | undefined
    let scanTimer: number | undefined
    const reader = new BrowserQRCodeReader()
    const scanCanvas = document.createElement('canvas')
    setError('')

    const scan = () => {
      if (disposed) return
      if (drawCameraFrame(video, canvas) && drawScanRegion(canvas, scanCanvas)) {
        try {
          const result = reader.decodeFromCanvas(scanCanvas)
          onReadRef.current(result.getText())
        } catch {
          // Frames without a readable QR are normal during continuous scanning.
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
          <>
            <video className="scanner-source" ref={videoRef} muted playsInline aria-hidden="true" />
            <canvas className="scanner-preview" ref={canvasRef} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} aria-label="QRコード読み取りカメラ" />
            <div className="scanner-reticle" aria-hidden="true" />
          </>
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
