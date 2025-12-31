"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    overlayClassName?: string
  }
>(({ className, children, overlayClassName, ...props }, ref) => {
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const [isMobile, setIsMobile] = React.useState(false)
  const [isDragging, setIsDragging] = React.useState(false)
  const [dragOffset, setDragOffset] = React.useState(0)
  const dragOffsetRef = React.useRef(0)
  const startYRef = React.useRef(0)

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    const media = window.matchMedia("(max-width: 640px)")
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  const updateDragOffset = (nextOffset: number) => {
    dragOffsetRef.current = nextOffset
    setDragOffset(nextOffset)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isMobile || event.pointerType === "mouse") {
      return
    }

    event.preventDefault()
    startYRef.current = event.clientY
    setIsDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) {
      return
    }

    const nextOffset = Math.max(0, event.clientY - startYRef.current)
    updateDragOffset(nextOffset)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) {
      return
    }

    event.currentTarget.releasePointerCapture(event.pointerId)
    setIsDragging(false)

    const threshold = Math.min(180, window.innerHeight * 0.25)
    if (dragOffsetRef.current > threshold) {
      closeRef.current?.click()
      return
    }

    updateDragOffset(0)
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) {
      return
    }

    event.currentTarget.releasePointerCapture(event.pointerId)
    setIsDragging(false)
    updateDragOffset(0)
  }

  const contentStyle =
    isMobile && dragOffset > 0
      ? { ...props.style, transform: `translate3d(0, ${dragOffset}px, 0)` }
      : props.style

  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed inset-0 z-50 grid h-[100dvh] w-full max-w-none gap-4 border border-border/70 bg-background p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] shadow-2xl transition-transform data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-6 data-[state=open]:slide-in-from-bottom-6 data-[dragging=true]:duration-0 data-[dragging=true]:ease-linear sm:inset-auto sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[85vh] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:overflow-y-auto sm:rounded-lg sm:shadow-lg sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%] sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
          className
        )}
        data-dragging={isDragging ? "true" : "false"}
        style={contentStyle}
        {...props}
      >
        {isMobile ? (
          <div
            className="absolute inset-x-0 top-0 z-10 flex h-10 items-start justify-center pt-2 touch-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            aria-hidden="true"
          >
            <span className="h-1.5 w-12 rounded-full bg-foreground/20" />
          </div>
        ) : null}
        {children}
        <DialogPrimitive.Close
          ref={closeRef}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
