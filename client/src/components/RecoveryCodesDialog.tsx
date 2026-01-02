"use client"

import * as React from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

type RecoveryCodesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  recoveryCodesText: string
  recoveryConfirmed: boolean
  onRecoveryConfirmedChange: (checked: boolean) => void
  onDone: () => void
  title?: string
  description?: string
  confirmLabel?: string
  doneLabel?: string
}

export function RecoveryCodesDialog({
  open,
  onOpenChange,
  recoveryCodesText,
  recoveryConfirmed,
  onRecoveryConfirmedChange,
  onDone,
  title = "Save your recovery codes",
  description = "Store these codes somewhere safe. Each code can be used once if you lose access to your authenticator.",
  confirmLabel = "I have saved these codes",
  doneLabel = "Continue",
}: RecoveryCodesDialogProps) {
  const [copied, setCopied] = React.useState(false)
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const copyToClipboard = React.useCallback(async (value: string): Promise<boolean> => {
    if (!value) {
      return false
    }
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value)
        return true
      } catch {
        // Fall back to execCommand
      }
    }

    try {
      const textarea = document.createElement("textarea")
      textarea.value = value
      textarea.setAttribute("readonly", "true")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      textarea.style.left = "-9999px"
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      textarea.setSelectionRange(0, textarea.value.length)
      const success = document.execCommand("copy")
      document.body.removeChild(textarea)
      return success
    } catch {
      return false
    }
  }, [])

  const handleCopyRecoveryCodes = React.useCallback(async () => {
    if (!recoveryCodesText) {
      return
    }
    const copiedSuccessfully = await copyToClipboard(recoveryCodesText)
    if (copiedSuccessfully) {
      setCopied(true)
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false)
      }, 5000)
    }
  }, [copyToClipboard, recoveryCodesText])

  React.useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  const { leftColumn, rightColumn } = React.useMemo(() => {
    const lines = recoveryCodesText
      ? recoveryCodesText.split("\n").map((line) => line.trim()).filter(Boolean)
      : []
    const midpoint = Math.ceil(lines.length / 2)
    return {
      leftColumn: lines.slice(0, midpoint),
      rightColumn: lines.slice(midpoint),
    }
  }, [recoveryCodesText])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="relative max-h-[50vh] rounded-md border bg-muted/50 p-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 z-10 h-7 w-7"
            onClick={handleCopyRecoveryCodes}
            title={copied ? "Copied" : "Copy recovery codes"}
            aria-label={copied ? "Copied recovery codes" : "Copy recovery codes"}
            disabled={!recoveryCodesText}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          <div className="flex max-h-[50vh] items-center justify-center overflow-auto">
            <div className="grid w-fit grid-cols-2 gap-x-10 font-mono text-xs text-foreground">
              <div className="flex flex-col gap-1 text-left">
                {leftColumn.map((line, index) => (
                  <span key={`left-${line}-${index}`} className="whitespace-nowrap leading-snug">
                    {line}
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-1 text-left">
                {rightColumn.map((line, index) => (
                  <span key={`right-${line}-${index}`} className="whitespace-nowrap leading-snug">
                    {line}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            id="recovery-confirmed"
            checked={recoveryConfirmed}
            onCheckedChange={onRecoveryConfirmedChange}
          />
          <Label htmlFor="recovery-confirmed" className="text-sm">
            {confirmLabel}
          </Label>
        </div>
        <DialogFooter>
          <Button onClick={onDone} disabled={!recoveryConfirmed}>
            {doneLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
