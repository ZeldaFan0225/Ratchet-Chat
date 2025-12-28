import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

export type SnapAnchor =
  | "TL" | "TC" | "TR"
  | "ML" | "MR"
  | "BL" | "BC" | "BR"

export type HiddenEdge = "left" | "right" | "top" | "bottom" | null

type ViewportMetrics = {
  width: number
  height: number
  offsetLeft: number
  offsetTop: number
}

type UseDraggableConfig = {
  initialAnchor?: SnapAnchor
  margin?: number
  hideThreshold?: number
  enabled?: boolean
}

const getAnchorPosition = (
  anchor: SnapAnchor,
  rect: DOMRect,
  viewport: ViewportMetrics,
  margin: number
) => {
  const { width: winW, height: winH, offsetLeft, offsetTop } = viewport
  let targetX = 0
  let targetY = 0

  switch (anchor) {
    case "TL": targetX = offsetLeft + margin; targetY = offsetTop + margin; break
    case "TC": targetX = offsetLeft + (winW - rect.width) / 2; targetY = offsetTop + margin; break
    case "TR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + margin; break
    case "ML": targetX = offsetLeft + margin; targetY = offsetTop + (winH - rect.height) / 2; break
    case "MR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + (winH - rect.height) / 2; break
    case "BL": targetX = offsetLeft + margin; targetY = offsetTop + winH - margin - rect.height; break
    case "BC": targetX = offsetLeft + (winW - rect.width) / 2; targetY = offsetTop + winH - margin - rect.height; break
    case "BR": targetX = offsetLeft + winW - margin - rect.width; targetY = offsetTop + winH - margin - rect.height; break
  }

  const minX = offsetLeft + margin
  const minY = offsetTop + margin
  const maxX = offsetLeft + Math.max(margin, winW - margin - rect.width)
  const maxY = offsetTop + Math.max(margin, winH - margin - rect.height)

  return {
    x: Math.max(minX, Math.min(targetX, maxX)),
    y: Math.max(minY, Math.min(targetY, maxY)),
  }
}

export function useDraggable(config: UseDraggableConfig = {}) {
  const {
    initialAnchor = "BR",
    margin = 16,
    hideThreshold = 30,
    enabled = true,
  } = config

  const ref = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [anchor, setAnchor] = useState<SnapAnchor>(initialAnchor)
  const [canAnimate, setCanAnimate] = useState(false)
  const [isHidden, setIsHidden] = useState(false)
  const [hiddenEdge, setHiddenEdge] = useState<HiddenEdge>(null)
  const [viewport, setViewport] = useState<ViewportMetrics>({
    width: 0,
    height: 0,
    offsetLeft: 0,
    offsetTop: 0,
  })

  // Track viewport size
  useEffect(() => {
    if (typeof window === "undefined" || !enabled) return
    const handleResize = () => {
      const vv = window.visualViewport
      setViewport({
        width: vv?.width ?? window.innerWidth,
        height: vv?.height ?? window.innerHeight,
        offsetLeft: vv?.offsetLeft ?? 0,
        offsetTop: vv?.offsetTop ?? 0,
      })
    }
    handleResize()
    window.addEventListener("resize", handleResize)
    window.visualViewport?.addEventListener("resize", handleResize)
    window.visualViewport?.addEventListener("scroll", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
      window.visualViewport?.removeEventListener("resize", handleResize)
      window.visualViewport?.removeEventListener("scroll", handleResize)
    }
  }, [enabled])

  // Initialize position on mount
  useEffect(() => {
    if (enabled && !position && viewport.width > 0) {
      setAnchor(initialAnchor)
    }
  }, [enabled, position, viewport, initialAnchor])

  useEffect(() => {
    if (!enabled) {
      setCanAnimate(false)
    }
  }, [enabled])

  const syncPosition = useCallback(() => {
    if (!ref.current || typeof window === "undefined") return false

    const rect = ref.current.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false

    const fallbackViewport: ViewportMetrics = {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
    }
    const currentViewport =
      viewport.width > 0 ? viewport : (window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetLeft: window.visualViewport.offsetLeft,
            offsetTop: window.visualViewport.offsetTop,
          }
        : fallbackViewport)

    setPosition(getAnchorPosition(anchor, rect, currentViewport, margin))
    return true
  }, [anchor, viewport, margin])

  // Recalculate position when anchor or window changes
  useLayoutEffect(() => {
    if (isDragging || !enabled || isHidden) return

    let frameId = 0
    const handleSnap = () => {
      const didSync = syncPosition()
      if (didSync && !canAnimate) {
        setCanAnimate(true)
      }
      if (!didSync) {
        frameId = requestAnimationFrame(handleSnap)
      }
    }

    handleSnap()
    return () => cancelAnimationFrame(frameId)
  }, [isDragging, enabled, isHidden, syncPosition, canAnimate])

  // Keep position synced when element resizes
  useEffect(() => {
    if (!enabled || !ref.current || isHidden) return
    const element = ref.current
    const observer = new ResizeObserver(() => {
      if (isDragging) return
      syncPosition()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, isDragging, isHidden, syncPosition])

  const checkHiddenEdge = useCallback((pos: { x: number; y: number }): HiddenEdge => {
    if (!ref.current) return null
    const rect = ref.current.getBoundingClientRect()
    const { width: winW, height: winH } = viewport.width > 0 ? viewport : {
      width: window.innerWidth,
      height: window.innerHeight,
    }

    // Check if dragged to edge (element center near edge)
    const centerX = pos.x + rect.width / 2
    const centerY = pos.y + rect.height / 2

    if (pos.x < -rect.width / 2 + hideThreshold) return "left"
    if (pos.x > winW - rect.width / 2 - hideThreshold) return "right"
    if (pos.y < -rect.height / 2 + hideThreshold) return "top"
    if (pos.y > winH - rect.height / 2 - hideThreshold) return "bottom"

    return null
  }, [viewport, hideThreshold])

  const findNearestAnchor = useCallback(() => {
    if (!ref.current || typeof window === "undefined") return

    const rect = ref.current.getBoundingClientRect()
    const currentViewport = viewport.width > 0 ? viewport : {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
    }
    const { width: winW, height: winH, offsetLeft, offsetTop } = currentViewport

    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    const targets: { id: SnapAnchor; x: number; y: number }[] = [
      { id: "TL", x: offsetLeft + margin + rect.width / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "TC", x: offsetLeft + winW / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "TR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + margin + rect.height / 2 },
      { id: "ML", x: offsetLeft + margin + rect.width / 2, y: offsetTop + winH / 2 },
      { id: "MR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + winH / 2 },
      { id: "BL", x: offsetLeft + margin + rect.width / 2, y: offsetTop + winH - margin - rect.height / 2 },
      { id: "BC", x: offsetLeft + winW / 2, y: offsetTop + winH - margin - rect.height / 2 },
      { id: "BR", x: offsetLeft + winW - margin - rect.width / 2, y: offsetTop + winH - margin - rect.height / 2 },
    ]

    let best = targets[0]
    let minDist = Number.MAX_VALUE

    for (const t of targets) {
      const dist = (cx - t.x) ** 2 + (cy - t.y) ** 2
      if (dist < minDist) {
        minDist = dist
        best = t
      }
    }

    setAnchor(best.id)
  }, [viewport, margin])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!ref.current || !enabled) return
    e.preventDefault()
    e.stopPropagation()

    const rect = ref.current.getBoundingClientRect()
    setPosition({ x: rect.left, y: rect.top })
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
    setIsDragging(true)
    setIsHidden(false)
    setHiddenEdge(null)
    ref.current.setPointerCapture(e.pointerId)
  }, [enabled])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return
    setPosition({
      x: e.clientX - dragOffset.x,
      y: e.clientY - dragOffset.y,
    })
  }, [isDragging, dragOffset])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !ref.current) return
    setIsDragging(false)
    ref.current.releasePointerCapture(e.pointerId)

    // Check if should hide
    const currentPos = position ?? { x: 0, y: 0 }
    const edge = checkHiddenEdge(currentPos)
    if (edge) {
      setIsHidden(true)
      setHiddenEdge(edge)
    } else {
      findNearestAnchor()
    }
  }, [isDragging, position, checkHiddenEdge, findNearestAnchor])

  const show = useCallback(() => {
    setIsHidden(false)
    setHiddenEdge(null)
    // Will snap to nearest anchor on next render
  }, [])

  // Get hidden position (off-screen)
  const getHiddenPosition = useCallback(() => {
    if (!ref.current || !hiddenEdge) return position
    const rect = ref.current.getBoundingClientRect()
    const { width: winW, height: winH } = viewport.width > 0 ? viewport : {
      width: window.innerWidth,
      height: window.innerHeight,
    }

    switch (hiddenEdge) {
      case "left": return { x: -rect.width - 10, y: position?.y ?? winH / 2 }
      case "right": return { x: winW + 10, y: position?.y ?? winH / 2 }
      case "top": return { x: position?.x ?? winW / 2, y: -rect.height - 10 }
      case "bottom": return { x: position?.x ?? winW / 2, y: winH + 10 }
      default: return position
    }
  }, [hiddenEdge, position, viewport])

  const displayPosition = isHidden ? getHiddenPosition() : position

  return {
    ref,
    position: displayPosition,
    isDragging,
    isHidden,
    hiddenEdge,
    anchor,
    canAnimate,
    show,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
    },
  }
}
