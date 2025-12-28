"use client"

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { VisuallyHidden } from "@radix-ui/react-visually-hidden"

export function ImagePreviewDialog({
  src,
  open,
  onOpenChange,
  modal = false,
}: {
  src: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  modal?: boolean
}) {
  if (!src) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogContent className="w-screen h-screen max-w-none m-0 p-0 border-none bg-black/95 flex items-center justify-center translate-x-0 translate-y-0 top-0 left-0 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 rounded-none shadow-none">
        <VisuallyHidden>
          <DialogTitle>Image Preview</DialogTitle>
        </VisuallyHidden>
        <div className="relative w-full h-full flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="Full screen preview"
            className="max-w-full max-h-full w-auto h-auto object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
