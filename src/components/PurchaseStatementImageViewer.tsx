import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { Minus, Plus } from 'lucide-react'

type Point = { x: number; y: number }
type Anchor = { x: number; y: number; imageX: number; imageY: number }
type Pinch = { distance: number; zoom: number; imageX: number; imageY: number }

function pinchGeometry(points: Map<number, Point>) {
  if (points.size !== 2) return null
  const [first, second] = [...points.values()]
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    distance: Math.hypot(first.x - second.x, first.y - second.y),
  }
}

export function PurchaseStatementImageViewer({ url, onError }: { url: string; onError: () => void }) {
  const [aspectRatio, setAspectRatio] = useState(0)
  const [zoom, setZoom] = useState(100)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const pinch = useRef<Pinch | null>(null)
  const pendingAnchor = useRef<Anchor | null>(null)

  const keepImagePoint = ({ x, y, imageX, imageY }: Anchor) => {
    const viewport = viewportRef.current
    const image = imageRef.current?.getBoundingClientRect()
    if (!viewport || !image) return
    viewport.scrollLeft += image.left + imageX * image.width - x
    viewport.scrollTop += image.top + imageY * image.height - y
  }

  useLayoutEffect(() => {
    if (pendingAnchor.current) {
      keepImagePoint(pendingAnchor.current)
      pendingAnchor.current = null
    }
  }, [zoom])

  const startPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !aspectRatio || pointers.current.size === 2) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const geometry = pinchGeometry(pointers.current)
    const image = imageRef.current?.getBoundingClientRect()
    if (geometry && geometry.distance > 0 && image) {
      // Remember the image point under the fingers so zoom does not jump away from it.
      pinch.current = {
        zoom,
        distance: geometry.distance,
        imageX: (geometry.x - image.left) / image.width,
        imageY: (geometry.y - image.top) / image.height,
      }
    }
  }

  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const geometry = pinchGeometry(pointers.current)
    if (geometry && pinch.current) {
      const { distance, zoom: startZoom, imageX, imageY } = pinch.current
      const next = Math.round(Math.max(100, Math.min(400, startZoom * geometry.distance / distance)))
      const anchor = { x: geometry.x, y: geometry.y, imageX, imageY }
      if (next === zoom) keepImagePoint(anchor)
      pendingAnchor.current = next === zoom ? null : anchor
      setZoom(next)
    } else if (pointers.current.size === 1) {
      event.currentTarget.scrollLeft += previous.x - event.clientX
      event.currentTarget.scrollTop += previous.y - event.clientY
    }
  }

  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (pointers.current.delete(event.pointerId)) pinch.current = null
  }

  return <>
    <div className="purchase-statement-image-controls" role="group" aria-label="画像の拡大・縮小">
      <button className="secondary-button" type="button" aria-label="画像を縮小" disabled={!aspectRatio || zoom === 100} onClick={() => setZoom((value) => Math.max(100, value - 50))}><Minus size={18} />縮小</button>
      <output aria-live="polite">{zoom}%</output>
      <button className="secondary-button" type="button" aria-label="画像を拡大" disabled={!aspectRatio || zoom === 400} onClick={() => setZoom((value) => Math.min(400, value + 50))}><Plus size={18} />拡大</button>
      <button className="secondary-button" type="button" disabled={!aspectRatio || zoom === 100} onClick={() => setZoom(100)}>全体表示</button>
    </div>
    <div ref={viewportRef} className="purchase-statement-image-viewport" role="region" aria-label="仕切書画像の表示範囲" tabIndex={0}
      style={aspectRatio ? { aspectRatio } : undefined}
      onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={endPointer}
      onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
      <img ref={imageRef} src={url} alt="保存した仕切書" draggable={false}
        style={aspectRatio ? { width: `min(${zoom}%, calc(var(--statement-image-area-height) * ${aspectRatio * zoom / 100}))` } : undefined}
        onLoad={(event) => setAspectRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
        onError={onError} />
    </div>
  </>
}
