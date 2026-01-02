"use client"

import * as React from "react"
import { Ban, Bell, Camera, Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, Fingerprint, Key, Lock, LogOut, Monitor, Palette, Plus, Server, Shield, Trash2, User, X } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useAuth, type SessionInfo, type PasskeyInfo, type AuthMethods } from "@/context/AuthContext"
import { useBlock } from "@/context/BlockContext"
import { useCall } from "@/context/CallContext"
import { useSync } from "@/context/SyncContext"
import { useSettings } from "@/hooks/useSettings"
import {
  getSessionNotificationsEnabled,
  setSessionNotificationsEnabled,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSubscribed,
} from "@/lib/push"
import type { PrivacyScope, MessageAcceptance, ChatBackground, CustomizationSettings } from "@/context/SettingsContext"
import { THEME_PRESETS, DEFAULT_CUSTOMIZATION, getThemePreset } from "@/context/SettingsContext"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { RecoveryCodesDialog } from "@/components/RecoveryCodesDialog"
import { WhatsNewBadge } from "@/components/WhatsNewBadge"
import { useWhatsNew } from "@/hooks/useWhatsNew"
import { formatRecoveryCodes } from "@/lib/totp"

function parseDeviceInfo(userAgent: string | null): string {
  if (!userAgent) return "Unknown device"

  // Simple parsing - extract browser and OS hints
  if (userAgent.includes("Chrome")) {
    if (userAgent.includes("Mobile")) return "Chrome Mobile"
    return "Chrome"
  }
  if (userAgent.includes("Firefox")) return "Firefox"
  if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) return "Safari"
  if (userAgent.includes("Edge")) return "Edge"

  return "Browser"
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return `${diffDays}d ago`
  if (diffHours > 0) return `${diffHours}h ago`
  if (diffMins > 0) return `${diffMins}m ago`
  return "just now"
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return "Unknown"
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return `${date.toLocaleString()} (${formatRelativeTime(date.toISOString())})`
}

function formatKeyPreview(key: string, head = 18, tail = 14): string {
  if (!key) return "Unavailable"
  if (key.length <= head + tail + 3) return key
  return `${key.slice(0, head)}...${key.slice(-tail)}`
}

const MAX_AVATAR_SIZE = 200 * 1024
const MAX_AVATAR_DIMENSION = 512
const MIN_AVATAR_DIMENSION = 128
const AVATAR_QUALITY_STEP = 0.1
const MIN_AVATAR_QUALITY = 0.5
const AVATAR_DIMENSION_STEP = 0.85

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Failed to load image"))
    }
    img.src = url
  })
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
}

function getCompressedType(mimeType: string): string {
  if (mimeType === "image/png" || mimeType === "image/webp") {
    return "image/webp"
  }
  return "image/jpeg"
}

function getCompressedFilename(originalName: string, outputType: string): string {
  const base = originalName.replace(/\.[^/.]+$/, "") || "avatar"
  const ext = outputType === "image/webp" ? "webp" : "jpg"
  return `${base}.${ext}`
}

async function renderAvatarBlob(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  outputType: string,
  quality: number
): Promise<{ blob: Blob; type: string } | null> {
  canvas.width = width
  canvas.height = height
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  let blob = await canvasToBlob(canvas, outputType, quality)
  let type = outputType

  if (!blob && outputType !== "image/jpeg") {
    const fallback = await canvasToBlob(canvas, "image/jpeg", quality)
    if (fallback) {
      blob = fallback
      type = "image/jpeg"
    }
  }

  if (!blob) {
    return null
  }

  return { blob, type }
}

async function compressAvatarImage(
  file: File,
  maxSize: number
): Promise<File> {
  const image = await loadImageFromFile(file)
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height

  if (!width || !height) {
    throw new Error("Invalid image dimensions")
  }

  const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(width, height))
  let targetWidth = Math.max(1, Math.round(width * scale))
  let targetHeight = Math.max(1, Math.round(height * scale))
  let outputType = getCompressedType(file.type)

  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("Canvas not available")
  }
  ctx.imageSmoothingQuality = "high"

  let dimensionAttempts = 0
  while (dimensionAttempts < 6) {
    for (
      let quality = 0.9;
      quality >= MIN_AVATAR_QUALITY;
      quality -= AVATAR_QUALITY_STEP
    ) {
      const rendered = await renderAvatarBlob(
        image,
        canvas,
        ctx,
        targetWidth,
        targetHeight,
        outputType,
        quality
      )
      if (!rendered) {
        continue
      }
      outputType = rendered.type
      if (rendered.blob.size <= maxSize) {
        return new File([rendered.blob], getCompressedFilename(file.name, outputType), {
          type: outputType,
        })
      }
    }

    if (Math.max(targetWidth, targetHeight) <= MIN_AVATAR_DIMENSION) {
      break
    }

    targetWidth = Math.max(
      MIN_AVATAR_DIMENSION,
      Math.round(targetWidth * AVATAR_DIMENSION_STEP)
    )
    targetHeight = Math.max(
      MIN_AVATAR_DIMENSION,
      Math.round(targetHeight * AVATAR_DIMENSION_STEP)
    )
    dimensionAttempts += 1
  }

  throw new Error("Unable to compress image below size limit")
}

type SettingsPage = "personalization" | "customization" | "privacy" | "notifications" | "access" | "security" | "blocking"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    user,
    publicIdentityKey,
    deleteAccount,
    fetchSessions,
    invalidateSession,
    invalidateAllOtherSessions,
    rotateTransportKey,
    getTransportKeyRotatedAt,
    fetchPasskeys,
    addPasskey,
    removePasskey,
    fetchAuthMethods,
    addPasswordAuth,
    removePasswordAuth,
    regenerateTotp,
    regenerateRecoveryCodes,
    changeAccountPassword,
    capabilities,
  } = useAuth()
  const { blockedUsers, blockedServers, blockUser, unblockUser, blockServer, unblockServer } = useBlock()
  const { callState } = useCall()
  const { settings, updateSettings } = useSettings()
  const { subscribe } = useSync()
  const { hasNewVersion, markAsSeen, currentVersion } = useWhatsNew()
  const isInActiveCall = callState.status !== "idle" && callState.status !== "ended"
  const avatarUrl = settings.avatarFilename
    ? `${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${settings.avatarFilename}`
    : undefined
  const displayNameFallback =
    settings.displayName?.trim() || user?.username || user?.handle || "User"
  const avatarFallbackText = displayNameFallback.slice(0, 2).toUpperCase()
  const [displayNameInput, setDisplayNameInput] = React.useState(
    settings.displayName ?? ""
  )
  const [showKey, setShowKey] = React.useState(false)
  const [deleteConfirm, setDeleteConfirm] = React.useState("")
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [isRotatingTransportKey, setIsRotatingTransportKey] = React.useState(false)
  const [rotateTransportError, setRotateTransportError] = React.useState<string | null>(null)
  const [transportRotatedAt, setTransportRotatedAt] = React.useState<number | null>(null)
  const [loadingTransportRotatedAt, setLoadingTransportRotatedAt] = React.useState(false)
  const [activePage, setActivePage] = React.useState<SettingsPage | null>(null)

  // Session management state
  const [sessions, setSessions] = React.useState<SessionInfo[]>([])
  const [loadingSessions, setLoadingSessions] = React.useState(false)
  const [invalidatingSessionId, setInvalidatingSessionId] = React.useState<string | null>(null)

  // Passkey management state
  const [passkeys, setPasskeys] = React.useState<PasskeyInfo[]>([])
  const [loadingPasskeys, setLoadingPasskeys] = React.useState(false)
  const [addingPasskey, setAddingPasskey] = React.useState(false)
  const [removingPasskeyId, setRemovingPasskeyId] = React.useState<string | null>(null)
  const [passkeyError, setPasskeyError] = React.useState<string | null>(null)
  const [newPasskeyName, setNewPasskeyName] = React.useState("")

  // Auth method state
  const [authMethods, setAuthMethods] = React.useState<AuthMethods | null>(null)
  const [loadingAuthMethods, setLoadingAuthMethods] = React.useState(false)
  const [authMethodsError, setAuthMethodsError] = React.useState<string | null>(null)
  const [passwordSetupAccountPassword, setPasswordSetupAccountPassword] = React.useState("")
  const [passwordSetupConfirmAccountPassword, setPasswordSetupConfirmAccountPassword] = React.useState("")
  const [passwordSetupMasterPassword, setPasswordSetupMasterPassword] = React.useState("")
  const [passwordSetupConfirmMasterPassword, setPasswordSetupConfirmMasterPassword] = React.useState("")
  const [passwordSetupError, setPasswordSetupError] = React.useState<string | null>(null)
  const [passwordSetupLoading, setPasswordSetupLoading] = React.useState(false)
  const [passwordActionError, setPasswordActionError] = React.useState<string | null>(null)
  const [passwordActionLoading, setPasswordActionLoading] = React.useState(false)
  const [totpFlow, setTotpFlow] = React.useState<{
    title: string
    description: string
    totpSecret: string
    totpUri: string
    onVerify: (code: string) => Promise<string[]>
  } | null>(null)
  const [totpCode, setTotpCode] = React.useState("")
  const [totpFlowError, setTotpFlowError] = React.useState<string | null>(null)
  const [totpFlowLoading, setTotpFlowLoading] = React.useState(false)
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([])
  const [recoveryModalOpen, setRecoveryModalOpen] = React.useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = React.useState(false)

  // Password change state
  const [passwordChangeDialogOpen, setPasswordChangeDialogOpen] = React.useState(false)
  const [passwordChangeCurrentPassword, setPasswordChangeCurrentPassword] = React.useState("")
  const [passwordChangeNewPassword, setPasswordChangeNewPassword] = React.useState("")
  const [passwordChangeConfirmPassword, setPasswordChangeConfirmPassword] = React.useState("")
  const [passwordChangeError, setPasswordChangeError] = React.useState<string | null>(null)
  const [passwordChangeLoading, setPasswordChangeLoading] = React.useState(false)

  // Block list state
  const [newBlockedUser, setNewBlockedUser] = React.useState("")
  const [newBlockedServer, setNewBlockedServer] = React.useState("")
  const [blockError, setBlockError] = React.useState<string | null>(null)

  // Session notifications state (device-specific)
  const [sessionNotifications, setSessionNotifications] = React.useState(true)
  const [loadingSessionNotifications, setLoadingSessionNotifications] = React.useState(true)

  // Push subscription state
  const [pushSubscribed, setPushSubscribed] = React.useState(false)
  const [pushSubscribing, setPushSubscribing] = React.useState(false)

  const identityKey = publicIdentityKey ?? ""
  const identityKeyPreview = formatKeyPreview(identityKey)
  const password2faAvailable = capabilities?.password_2fa === true
  const recoveryCodesText = React.useMemo(
    () => (recoveryCodes.length > 0 ? formatRecoveryCodes(recoveryCodes) : ""),
    [recoveryCodes]
  )

  const deleteLabel = user?.handle ?? user?.username ?? ""
  const isDeleteMatch = deleteLabel !== "" && deleteConfirm.trim() === deleteLabel

  React.useEffect(() => {
    setDisplayNameInput(settings.displayName ?? "")
  }, [settings.displayName])

  const commitDisplayName = React.useCallback(() => {
    const trimmed = displayNameInput.trim()
    const nextValue = trimmed.length > 0 ? trimmed : null
    if ((settings.displayName ?? null) !== nextValue) {
      void updateSettings({ displayName: nextValue })
    }
    if (displayNameInput !== trimmed) {
      setDisplayNameInput(trimmed)
    }
  }, [displayNameInput, settings.displayName, updateSettings])

  // Fetch sessions when dialog opens
  const loadSessions = React.useCallback(async () => {
    setLoadingSessions(true)
    try {
      const data = await fetchSessions()
      setSessions(data)
    } catch {
      // Handle error silently
    } finally {
      setLoadingSessions(false)
    }
  }, [fetchSessions])

  const loadTransportRotation = React.useCallback(async () => {
    setLoadingTransportRotatedAt(true)
    try {
      const timestamp = await getTransportKeyRotatedAt()
      setTransportRotatedAt(timestamp)
    } finally {
      setLoadingTransportRotatedAt(false)
    }
  }, [getTransportKeyRotatedAt])

  // Subscribe to transport key rotation events to update timestamp
  React.useEffect(() => {
    const unsubscribe = subscribe("TRANSPORT_KEY_ROTATED", () => {
      void loadTransportRotation()
    })
    return unsubscribe
  }, [subscribe, loadTransportRotation])

  const loadPasskeys = React.useCallback(async () => {
    setLoadingPasskeys(true)
    setPasskeyError(null)
    try {
      const data = await fetchPasskeys()
      setPasskeys(data)
    } catch {
      setPasskeyError("Unable to load passkeys")
    } finally {
      setLoadingPasskeys(false)
    }
  }, [fetchPasskeys])

  const loadAuthMethods = React.useCallback(async () => {
    setLoadingAuthMethods(true)
    setAuthMethodsError(null)
    try {
      const data = await fetchAuthMethods()
      setAuthMethods(data)
    } catch {
      setAuthMethodsError("Unable to load authentication methods")
    } finally {
      setLoadingAuthMethods(false)
    }
  }, [fetchAuthMethods])

  const handleAddPasskey = React.useCallback(async () => {
    setAddingPasskey(true)
    setPasskeyError(null)
    try {
      const passkey = await addPasskey(newPasskeyName.trim() || undefined)
      setPasskeys((prev) => [...prev, passkey])
      setNewPasskeyName("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to add passkey"
      // Handle user cancellation gracefully
      if (message.includes("cancelled") || message.includes("canceled") || message.includes("abort")) {
        setPasskeyError(null)
      } else {
        setPasskeyError(message)
      }
    } finally {
      setAddingPasskey(false)
    }
  }, [addPasskey, newPasskeyName])

  const handleRemovePasskey = React.useCallback(async (credentialId: string) => {
    if (passkeys.length <= 1) {
      setPasskeyError("You must have at least one passkey to access your account")
      return
    }
    const confirmed = window.confirm(
      "Remove this passkey? You'll need to authenticate with a different passkey to confirm."
    )
    if (!confirmed) return

    setRemovingPasskeyId(credentialId)
    setPasskeyError(null)
    try {
      await removePasskey(credentialId)
      setPasskeys((prev) => prev.filter((p) => p.credentialId !== credentialId))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to remove passkey"
      if (message.includes("cancelled") || message.includes("canceled") || message.includes("abort")) {
        setPasskeyError(null)
      } else {
        setPasskeyError(message)
      }
    } finally {
      setRemovingPasskeyId(null)
    }
  }, [removePasskey, passkeys.length])

  const handlePasswordSetupStart = React.useCallback(async () => {
    setPasswordSetupError(null)
    setPasswordActionError(null)
    const accountPassword = passwordSetupAccountPassword.trim()
    const confirmAccountPassword = passwordSetupConfirmAccountPassword.trim()
    const masterPassword = passwordSetupMasterPassword.trim()
    const confirmMasterPassword = passwordSetupConfirmMasterPassword.trim()

    if (accountPassword.length < 12) {
      setPasswordSetupError("Account password must be at least 12 characters")
      return
    }
    if (accountPassword !== confirmAccountPassword) {
      setPasswordSetupError("Account passwords do not match")
      return
    }
    if (masterPassword.length < 12) {
      setPasswordSetupError("Master password must be at least 12 characters")
      return
    }
    if (masterPassword !== confirmMasterPassword) {
      setPasswordSetupError("Master passwords do not match")
      return
    }

    setPasswordSetupLoading(true)
    try {
      const setup = await addPasswordAuth(accountPassword, masterPassword)
      setTotpFlow({
        title: "Verify your authenticator",
        description: "Scan the QR code, then enter the 6-digit code to finish setup.",
        totpSecret: setup.totpSecret,
        totpUri: setup.totpUri,
        onVerify: setup.onVerify,
      })
      setTotpCode("")
      setTotpFlowError(null)
      setPasswordSetupAccountPassword("")
      setPasswordSetupConfirmAccountPassword("")
      setPasswordSetupMasterPassword("")
      setPasswordSetupConfirmMasterPassword("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start setup"
      setPasswordSetupError(message)
    } finally {
      setPasswordSetupLoading(false)
    }
  }, [
    passwordSetupAccountPassword,
    passwordSetupConfirmAccountPassword,
    passwordSetupMasterPassword,
    passwordSetupConfirmMasterPassword,
    addPasswordAuth,
  ])

  const handleRegenerateTotp = React.useCallback(async () => {
    setPasswordActionError(null)
    setPasswordActionLoading(true)
    try {
      const setup = await regenerateTotp()
      setTotpFlow({
        title: "Regenerate authenticator",
        description: "Scan the new QR code, then enter the 6-digit code to confirm.",
        totpSecret: setup.totpSecret,
        totpUri: setup.totpUri,
        onVerify: setup.onVerify,
      })
      setTotpCode("")
      setTotpFlowError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to regenerate 2FA"
      setPasswordActionError(message)
    } finally {
      setPasswordActionLoading(false)
    }
  }, [regenerateTotp])

  const handleTotpFlowVerify = React.useCallback(async () => {
    if (!totpFlow) {
      return
    }
    setTotpFlowError(null)
    setTotpFlowLoading(true)
    try {
      const codes = await totpFlow.onVerify(totpCode.trim())
      setRecoveryCodes(codes)
      setRecoveryConfirmed(false)
      setRecoveryModalOpen(true)
      setTotpFlow(null)
      setTotpCode("")
      void loadAuthMethods()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify code"
      setTotpFlowError(message)
    } finally {
      setTotpFlowLoading(false)
    }
  }, [totpFlow, totpCode, loadAuthMethods])

  const handleRegenerateRecoveryCodes = React.useCallback(async () => {
    setPasswordActionError(null)
    setPasswordActionLoading(true)
    try {
      const codes = await regenerateRecoveryCodes()
      setRecoveryCodes(codes)
      setRecoveryConfirmed(false)
      setRecoveryModalOpen(true)
      void loadAuthMethods()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to regenerate recovery codes"
      setPasswordActionError(message)
    } finally {
      setPasswordActionLoading(false)
    }
  }, [regenerateRecoveryCodes, loadAuthMethods])

  const handleRemovePasswordLogin = React.useCallback(async () => {
    setPasswordActionError(null)
    if (!authMethods?.has_passkey) {
      setPasswordActionError("Add a passkey before removing password login")
      return
    }
    const confirmed = window.confirm(
      "Remove password login? You'll only be able to sign in with passkeys."
    )
    if (!confirmed) return

    setPasswordActionLoading(true)
    try {
      await removePasswordAuth()
      void loadAuthMethods()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to remove password login"
      setPasswordActionError(message)
    } finally {
      setPasswordActionLoading(false)
    }
  }, [authMethods?.has_passkey, removePasswordAuth, loadAuthMethods])

  const handleTotpFlowChange = React.useCallback((open: boolean) => {
    if (!open) {
      setTotpFlow(null)
      setTotpCode("")
      setTotpFlowError(null)
      setTotpFlowLoading(false)
    }
  }, [])

  const handleRecoveryModalChange = React.useCallback(
    (open: boolean) => {
      if (!open && !recoveryConfirmed) {
        return
      }
      setRecoveryModalOpen(open)
    },
    [recoveryConfirmed]
  )

  const handleRecoveryModalDone = React.useCallback(() => {
    if (!recoveryConfirmed) {
      return
    }
    setRecoveryModalOpen(false)
    setRecoveryConfirmed(false)
    setRecoveryCodes([])
  }, [recoveryConfirmed])

  const handlePasswordChangeDialogChange = React.useCallback((open: boolean) => {
    if (!open) {
      setPasswordChangeCurrentPassword("")
      setPasswordChangeNewPassword("")
      setPasswordChangeConfirmPassword("")
      setPasswordChangeError(null)
      setPasswordChangeLoading(false)
    }
    setPasswordChangeDialogOpen(open)
  }, [])

  const handlePasswordChange = React.useCallback(async () => {
    setPasswordChangeError(null)
    const currentPassword = passwordChangeCurrentPassword.trim()
    const newPassword = passwordChangeNewPassword.trim()
    const confirmPassword = passwordChangeConfirmPassword.trim()

    if (!currentPassword) {
      setPasswordChangeError("Current password is required")
      return
    }
    if (newPassword.length < 12) {
      setPasswordChangeError("New password must be at least 12 characters")
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordChangeError("Passwords do not match")
      return
    }
    if (currentPassword === newPassword) {
      setPasswordChangeError("New password must be different from current password")
      return
    }

    setPasswordChangeLoading(true)
    try {
      await changeAccountPassword(currentPassword, newPassword)
      handlePasswordChangeDialogChange(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to change password"
      setPasswordChangeError(message)
    } finally {
      setPasswordChangeLoading(false)
    }
  }, [
    passwordChangeCurrentPassword,
    passwordChangeNewPassword,
    passwordChangeConfirmPassword,
    changeAccountPassword,
    handlePasswordChangeDialogChange,
  ])

  React.useEffect(() => {
    if (open) {
      void loadSessions()
      void loadTransportRotation()
      void loadPasskeys()
      void loadAuthMethods()
    }
  }, [open, loadSessions, loadTransportRotation, loadPasskeys, loadAuthMethods])

  React.useEffect(() => {
    if (!open) {
      setDeleteConfirm("")
      setDeleteError(null)
      setIsDeleting(false)
      setRotateTransportError(null)
      setPasskeyError(null)
      setNewPasskeyName("")
      setAuthMethods(null)
      setAuthMethodsError(null)
      setPasswordSetupAccountPassword("")
      setPasswordSetupConfirmAccountPassword("")
      setPasswordSetupMasterPassword("")
      setPasswordSetupConfirmMasterPassword("")
      setPasswordSetupError(null)
      setPasswordSetupLoading(false)
      setPasswordActionError(null)
      setPasswordActionLoading(false)
      setTotpFlow(null)
      setTotpCode("")
      setTotpFlowError(null)
      setTotpFlowLoading(false)
      setRecoveryCodes([])
      setRecoveryModalOpen(false)
      setRecoveryConfirmed(false)
      setPasswordChangeDialogOpen(false)
      setPasswordChangeCurrentPassword("")
      setPasswordChangeNewPassword("")
      setPasswordChangeConfirmPassword("")
      setPasswordChangeError(null)
      setPasswordChangeLoading(false)
      setNewBlockedUser("")
      setNewBlockedServer("")
      setBlockError(null)
      setActivePage(null)
    }
  }, [open])

  // Load session notifications setting when dialog opens
  React.useEffect(() => {
    if (open) {
      setLoadingSessionNotifications(true)
      getSessionNotificationsEnabled()
        .then(setSessionNotifications)
        .finally(() => setLoadingSessionNotifications(false))

      // Check push subscription status
      isPushSubscribed().then(setPushSubscribed)
    }
  }, [open])

  const handleSessionNotificationsChange = React.useCallback((checked: boolean) => {
    setSessionNotifications(checked)
    void setSessionNotificationsEnabled(checked)
  }, [])

  const handlePushToggle = React.useCallback(async (checked: boolean) => {
    setPushSubscribing(true)
    try {
      if (checked) {
        // Subscribe to push notifications
        const success = await subscribeToPush()
        if (success) {
          setPushSubscribed(true)
          updateSettings({ pushNotificationsEnabled: true })
        } else {
          // Permission denied or subscription failed
          updateSettings({ pushNotificationsEnabled: false })
        }
      } else {
        // Unsubscribe from push notifications
        await unsubscribeFromPush()
        setPushSubscribed(false)
        updateSettings({ pushNotificationsEnabled: false })
      }
    } finally {
      setPushSubscribing(false)
    }
  }, [updateSettings])

  const handleBlockUser = React.useCallback(async () => {
    const handle = newBlockedUser.trim().toLowerCase()
    if (!handle) {
      setBlockError("Enter a user handle")
      return
    }
    if (!handle.includes("@")) {
      setBlockError("Enter a full handle like user@server.com")
      return
    }
    setBlockError(null)
    try {
      await blockUser(handle)
      setNewBlockedUser("")
    } catch (error) {
      setBlockError(error instanceof Error ? error.message : "Unable to block user")
    }
  }, [blockUser, newBlockedUser])

  const handleBlockServer = React.useCallback(async () => {
    const server = newBlockedServer.trim().toLowerCase()
    if (!server) {
      setBlockError("Enter a server address")
      return
    }
    if (server.includes("@")) {
      setBlockError("Enter just the server address without @")
      return
    }
    setBlockError(null)
    try {
      await blockServer(server)
      setNewBlockedServer("")
    } catch (error) {
      setBlockError(error instanceof Error ? error.message : "Unable to block server")
    }
  }, [blockServer, newBlockedServer])

  const handleInvalidateSession = React.useCallback(async (sessionId: string) => {
    setInvalidatingSessionId(sessionId)
    try {
      await invalidateSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } catch {
      // Handle error
    } finally {
      setInvalidatingSessionId(null)
    }
  }, [invalidateSession])

  const handleInvalidateAllOther = React.useCallback(async () => {
    try {
      await invalidateAllOtherSessions()
      setSessions((prev) => prev.filter((s) => s.isCurrent))
    } catch {
      // Handle error
    }
  }, [invalidateAllOtherSessions])

  const handleRotateTransportKey = React.useCallback(async () => {
    // Show extra warning if user is in an active call
    if (isInActiveCall) {
      const callWarningConfirmed = window.confirm(
        "You are currently in a call. Rotating your key now may disrupt the call. Are you sure you want to continue?"
      )
      if (!callWarningConfirmed) {
        return
      }
    }

    const confirmed = window.confirm(
      "Rotate your transport key? Other signed-in devices will be updated."
    )
    if (!confirmed) {
      return
    }
    setRotateTransportError(null)
    setIsRotatingTransportKey(true)
    try {
      await rotateTransportKey()
      void loadTransportRotation()
    } catch (error) {
      setRotateTransportError(
        error instanceof Error ? error.message : "Unable to rotate transport key"
      )
    } finally {
      setIsRotatingTransportKey(false)
    }
  }, [rotateTransportKey, isInActiveCall])

  const handleDeleteAccount = React.useCallback(async () => {
    if (!deleteLabel) return
    if (!isDeleteMatch) {
      setDeleteError(`Type ${deleteLabel} to confirm account deletion.`)
      return
    }
    const confirmed = window.confirm(
      "This will permanently delete your account and all server data. This cannot be undone."
    )
    if (!confirmed) {
      return
    }
    setDeleteError(null)
    setIsDeleting(true)
    try {
      await deleteAccount()
      onOpenChange(false)
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Unable to delete account"
      )
    } finally {
      setIsDeleting(false)
    }
  }, [deleteAccount, deleteLabel, isDeleteMatch, onOpenChange])

  const settingsPages = [
    {
      id: "personalization",
      title: "Personalization",
      description: "Profile picture and display name.",
      icon: User,
    },
    {
      id: "customization",
      title: "Customization",
      description: "Colors, themes, and chat appearance.",
      icon: Palette,
    },
    {
      id: "privacy",
      title: "Privacy",
      description: "Control what others can see.",
      icon: Eye,
    },
    {
      id: "notifications",
      title: "Notifications",
      description: "Push notification preferences.",
      icon: Bell,
    },
    {
      id: "access",
      title: "Access",
      description: "Passkeys and signed-in devices.",
      icon: Key,
    },
    {
      id: "security",
      title: "Security",
      description: "Keys, transport settings, and account safety.",
      icon: Shield,
    },
    {
      id: "blocking",
      title: "Blocking",
      description: "Manage blocked users and servers.",
      icon: Ban,
    },
  ] as const satisfies ReadonlyArray<{
    id: SettingsPage
    title: string
    description: string
    icon: React.ElementType
  }>

  const activePageInfo = activePage
    ? settingsPages.find((page) => page.id === activePage)
    : null
  const dialogDescription = activePageInfo
    ? activePageInfo.description
    : "Manage your privacy and security preferences."

  const settingsPageContent: Record<SettingsPage, React.ReactNode> = {
    personalization: (
      <div className="space-y-6 py-4">
        {/* Profile Picture */}
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Profile Picture</h3>
            <p className="text-xs text-muted-foreground">
              Add a picture so others can recognize you.
            </p>
          </div>
          <div className="rounded-md border border-muted-foreground/20 bg-muted/40 p-2 text-[10px] text-muted-foreground">
            Note: profile pictures and display names are stored unencrypted. If set to public,
            they are public-public.
          </div>
          
          <div className="flex items-center gap-6">
            <div className="relative group">
              <Avatar className="h-20 w-20 border">
                <AvatarImage key={avatarUrl ?? "empty"} src={avatarUrl} />
                <AvatarFallback className="text-xl">
                  {avatarFallbackText}
                </AvatarFallback>
              </Avatar>
              <label 
                htmlFor="avatar-upload" 
                className="absolute inset-0 flex items-center justify-center bg-black/40 text-white rounded-full opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity"
              >
                <Camera className="h-6 w-6" />
                <input 
                  id="avatar-upload" 
                  type="file" 
                  className="hidden" 
                  accept="image/jpeg,image/png,image/webp"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;

                    let uploadFile = file
                    if (file.size > MAX_AVATAR_SIZE) {
                      try {
                        uploadFile = await compressAvatarImage(file, MAX_AVATAR_SIZE)
                      } catch (error) {
                        console.error("Failed to compress avatar:", error)
                        alert("File is too large to upload. Please choose a smaller image.")
                        return
                      }
                    }

                    const formData = new FormData();
                    formData.append("avatar", uploadFile);

                    try {
                      const response = await apiFetch<{ filename: string }>("/auth/avatar", {
                        method: "POST",
                        body: formData,
                        // Note: apiFetch will handle the form data correctly if it sees FormData
                      });
                      void updateSettings({ avatarFilename: response.filename });
                    } catch (err) {
                      alert("Failed to upload avatar.");
                    }
                  }}
                />
              </label>
            </div>
            
            <div className="flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">Visibility</Label>
                  <p className="text-[10px] text-muted-foreground">
                    Show your picture to others.
                  </p>
                </div>
                <Switch 
                  checked={settings.avatarVisibility === "public"}
                  onCheckedChange={async (checked) => {
                    const visibility = checked ? "public" : "hidden";
                    await apiFetch("/auth/avatar/visibility", {
                      method: "PATCH",
                      body: { visibility }
                    });
                    void updateSettings({ avatarVisibility: visibility });
                  }}
                />
              </div>
              
              {settings.avatarFilename && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-8 text-[10px]"
                  onClick={async () => {
                    if (confirm("Remove profile picture?")) {
                      await apiFetch("/auth/avatar", { method: "DELETE" });
                      void updateSettings({ avatarFilename: null });
                    }
                  }}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Remove Picture
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="display-name">Display Name</Label>
            <p className="text-[10px] text-muted-foreground">
              Optional name for your own UI. Syncs across devices.
            </p>
            <Input
              id="display-name"
              value={displayNameInput}
              maxLength={64}
              placeholder={user?.username ?? "Your name"}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              onBlur={commitDisplayName}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  commitDisplayName()
                  event.currentTarget.blur()
                }
              }}
            />
            <div className="flex items-center justify-between gap-4 pt-1">
              <div className="space-y-0.5">
                <Label className="text-xs">Visibility</Label>
                <p className="text-[10px] text-muted-foreground">
                  Show your display name to others.
                </p>
              </div>
              <Switch
                checked={settings.displayNameVisibility === "public"}
                onCheckedChange={(checked) => {
                  void updateSettings({
                    displayNameVisibility: checked ? "public" : "hidden",
                  })
                }}
              />
            </div>
          </div>
        </div>
      </div>
    ),
    customization: (() => {
      const currentThemeId = settings.customization?.themeId ?? DEFAULT_CUSTOMIZATION.themeId
      const currentPreset = getThemePreset(currentThemeId)
      const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      const colors = isDark ? currentPreset.dark : currentPreset.light

      return (
        <div className="space-y-6 py-4">
          {/* Theme Presets */}
          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Theme</h3>
              <p className="text-xs text-muted-foreground">
                Choose a color theme for your chat.
              </p>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {THEME_PRESETS.map((preset) => {
                const presetColors = isDark ? preset.dark : preset.light
                const isSelected = currentThemeId === preset.id
                return (
                  <button
                    key={preset.id}
                    className={cn(
                      "relative rounded-xl border-2 p-2 transition-all hover:scale-[1.02]",
                      isSelected
                        ? "border-foreground shadow-md"
                        : "border-muted hover:border-muted-foreground/50"
                    )}
                    onClick={() => {
                      const newCustomization = {
                        ...(settings.customization ?? DEFAULT_CUSTOMIZATION),
                        themeId: preset.id,
                      }
                      void updateSettings({ customization: newCustomization })
                    }}
                  >
                    {/* Mini preview */}
                    <div className="space-y-1.5 rounded-lg bg-background p-2">
                      <div
                        className="h-4 w-3/4 rounded-lg rounded-bl-sm text-[6px] flex items-center px-1"
                        style={{
                          backgroundColor: presetColors.incomingBubble,
                          color: presetColors.incomingText,
                        }}
                      >
                        Hi!
                      </div>
                      <div
                        className="h-4 w-3/4 ml-auto rounded-lg rounded-br-sm text-[6px] flex items-center justify-end px-1"
                        style={{
                          backgroundColor: presetColors.outgoingBubble,
                          color: presetColors.outgoingText,
                        }}
                      >
                        Hey!
                      </div>
                    </div>
                    <p className="mt-1.5 text-[10px] font-medium truncate">{preset.name}</p>
                    {isSelected && (
                      <div
                        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: preset.accent }}
                      >
                        <Check className="h-3 w-3 text-white" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <Separator />

          {/* Live Preview */}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Preview</Label>
              <p className="text-xs text-muted-foreground">
                See how your messages will look.
              </p>
            </div>
            <div
              className={cn(
                "rounded-lg border p-4 space-y-2",
                settings.customization?.chatBackground === "dots" && "chat-bg-dots",
                settings.customization?.chatBackground === "grid" && "chat-bg-grid",
                settings.customization?.chatBackground === "waves" && "chat-bg-waves"
              )}
            >
              <div className="flex justify-start">
                <div
                  className={cn(
                    "max-w-[75%] rounded-2xl rounded-bl-sm text-xs",
                    settings.customization?.compactMode ? "px-2 py-1" : "px-3 py-2"
                  )}
                  style={{
                    backgroundColor: colors.incomingBubble,
                    color: colors.incomingText,
                  }}
                >
                  Hey! How are you?
                </div>
              </div>
              <div className="flex justify-end">
                <div
                  className={cn(
                    "max-w-[75%] rounded-2xl rounded-br-sm text-xs",
                    settings.customization?.compactMode ? "px-2 py-1" : "px-3 py-2"
                  )}
                  style={{
                    backgroundColor: colors.outgoingBubble,
                    color: colors.outgoingText,
                  }}
                >
                  I&apos;m doing great! 🎉
                </div>
              </div>
              <div className="flex justify-start">
                <div
                  className={cn(
                    "max-w-[75%] rounded-2xl rounded-bl-sm text-xs",
                    settings.customization?.compactMode ? "px-2 py-1" : "px-3 py-2"
                  )}
                  style={{
                    backgroundColor: colors.incomingBubble,
                    color: colors.incomingText,
                  }}
                >
                  That&apos;s awesome!
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Chat Background */}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Chat Background</Label>
              <p className="text-xs text-muted-foreground">
                Pattern for the chat area.
              </p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {(["none", "dots", "grid", "waves"] as ChatBackground[]).map((bg) => (
                <button
                  key={bg}
                  className={cn(
                    "h-14 rounded-lg border-2 transition-all flex items-center justify-center text-xs capitalize",
                    settings.customization?.chatBackground === bg
                      ? "border-foreground"
                      : "border-muted hover:border-muted-foreground/50",
                    bg === "dots" && "chat-bg-dots",
                    bg === "grid" && "chat-bg-grid",
                    bg === "waves" && "chat-bg-waves"
                  )}
                  onClick={() => {
                    const newCustomization = {
                      ...(settings.customization ?? DEFAULT_CUSTOMIZATION),
                      chatBackground: bg,
                    }
                    void updateSettings({ customization: newCustomization })
                  }}
                >
                  {bg}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Compact Mode */}
          <div className="flex items-center justify-between space-x-2">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Compact Mode</Label>
              <p className="text-xs text-muted-foreground">
                Denser message spacing.
              </p>
            </div>
            <Switch
              checked={settings.customization?.compactMode ?? false}
              onCheckedChange={(checked) => {
                const newCustomization = {
                  ...(settings.customization ?? DEFAULT_CUSTOMIZATION),
                  compactMode: checked,
                }
                void updateSettings({ customization: newCustomization })
              }}
            />
          </div>
        </div>
      )
    })(),
    privacy: (
      <div className="space-y-6 py-4">
        {/* Message Acceptance */}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-base">Who can message you</Label>
            <p className="text-xs text-muted-foreground">
              Control who can start new conversations with you.
            </p>
          </div>
          <Select
            value={settings.messageAcceptance}
            onValueChange={(value: MessageAcceptance) =>
              updateSettings({ messageAcceptance: value })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everybody">Everybody</SelectItem>
              <SelectItem value="same_server">Users from this server</SelectItem>
              <SelectItem value="contacts">My contacts only</SelectItem>
              <SelectItem value="nobody">Nobody (you message first)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Message Requests */}
        {settings.messageAcceptance !== "everybody" && (
          <div className="flex items-center justify-between space-x-2 rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-3 dark:border-amber-700 dark:bg-amber-950/30">
            <div className="space-y-1">
              <Label htmlFor="requests" className="text-sm">Message Requests</Label>
              <p className="text-xs text-muted-foreground">
                Messages from others appear in a separate inbox for review instead of being blocked.
              </p>
            </div>
            <Switch
              id="requests"
              checked={settings.enableMessageRequests}
              onCheckedChange={(checked) =>
                updateSettings({ enableMessageRequests: checked })
              }
            />
          </div>
        )}

        <Separator />

        {/* Typing Indicator */}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-base">Typing Indicator</Label>
            <p className="text-xs text-muted-foreground">
              Show others when you are typing a message.
            </p>
          </div>
          <Select
            value={settings.typingIndicatorScope}
            onValueChange={(value: PrivacyScope) =>
              updateSettings({ typingIndicatorScope: value })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everybody">Everybody</SelectItem>
              <SelectItem value="same_server">Users from this server</SelectItem>
              <SelectItem value="contacts">My contacts only</SelectItem>
              <SelectItem value="nobody">Nobody</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        {/* Read Receipts */}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-base">Read Receipts</Label>
            <p className="text-xs text-muted-foreground">
              Let others know when you have read their messages.
            </p>
          </div>
          <Select
            value={settings.sendReadReceiptsTo}
            onValueChange={(value: PrivacyScope) =>
              updateSettings({ sendReadReceiptsTo: value })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everybody">Everybody</SelectItem>
              <SelectItem value="same_server">Users from this server</SelectItem>
              <SelectItem value="contacts">My contacts only</SelectItem>
              <SelectItem value="nobody">Nobody</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Separator />

        {/* Link Previews */}
        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-1">
            <Label htmlFor="link-previews" className="text-base">Link Previews</Label>
            <p className="text-xs text-muted-foreground">
              Fetch and display previews for links in messages. Previews are fetched through the server.
            </p>
          </div>
          <Switch
            id="link-previews"
            checked={settings.enableLinkPreviews}
            onCheckedChange={(checked) =>
              updateSettings({ enableLinkPreviews: checked })
            }
          />
        </div>
      </div>
    ),
    access: (
      <div className="space-y-8 py-4">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Authentication methods</h3>
            <p className="text-xs text-muted-foreground">
              Manage passkeys and password-based access for this account.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">Passkeys</h4>
          </div>

          {loadingPasskeys ? (
            <p className="text-sm text-muted-foreground">Loading passkeys...</p>
          ) : (
            <div className="space-y-3">
              {passkeys.map((passkey) => (
                <div
                  key={passkey.id}
                  className="flex items-start justify-between rounded-lg border p-3"
                >
                  <div className="flex items-start gap-3">
                    <Key className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="space-y-1">
                      <span className="text-sm font-medium">
                        {passkey.name || "Passkey"}
                      </span>
                      <p className="text-xs text-muted-foreground">
                        Created {formatRelativeTime(passkey.createdAt)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Last used {formatRelativeTime(passkey.lastUsedAt)}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleRemovePasskey(passkey.credentialId)}
                    disabled={removingPasskeyId === passkey.credentialId || passkeys.length <= 1}
                    title={passkeys.length <= 1 ? "Cannot remove last passkey" : "Remove passkey"}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {passkeyError ? (
            <p className="text-sm text-destructive">{passkeyError}</p>
          ) : null}

          <div className="space-y-3 rounded-lg border p-4">
            <h4 className="text-sm font-medium">Add a new passkey</h4>
            <div className="space-y-2">
              <Label htmlFor="passkey-name" className="text-xs">
                Name (optional)
              </Label>
              <Input
                id="passkey-name"
                value={newPasskeyName}
                onChange={(e) => setNewPasskeyName(e.target.value)}
                placeholder="e.g., Work laptop, Phone"
                disabled={addingPasskey}
              />
            </div>
            <Button
              variant="accept"
              onClick={handleAddPasskey}
              disabled={addingPasskey}
              className="w-full"
            >
              <Plus className="mr-2 h-4 w-4" />
              {addingPasskey ? "Adding passkey..." : "Add Passkey"}
            </Button>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Password + 2FA</h4>
              <p className="text-xs text-muted-foreground">
                Set up a password login with a mandatory authenticator code.
              </p>
            </div>

            {!password2faAvailable ? (
              capabilities ? (
                <p className="text-xs text-muted-foreground">
                  Password authentication is disabled on this server.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Checking server capabilities...
                </p>
              )
            ) : loadingAuthMethods ? (
              <p className="text-sm text-muted-foreground">Loading authentication status...</p>
            ) : authMethodsError ? (
              <p className="text-sm text-destructive">{authMethodsError}</p>
            ) : authMethods?.has_password_2fa ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between rounded-lg border p-3">
                  <div className="space-y-1">
                    <span className="text-sm font-medium">Password login enabled</span>
                    <p className="text-xs text-muted-foreground">
                      Requires a password and authenticator code to sign in.
                    </p>
                  </div>
                  <Badge variant="outline">Enabled</Badge>
                </div>

                {passwordActionError ? (
                  <p className="text-sm text-destructive">{passwordActionError}</p>
                ) : null}

                <div className="grid gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setPasswordChangeDialogOpen(true)}
                    disabled={passwordActionLoading}
                    className="w-full"
                  >
                    Change Account Password
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleRegenerateTotp}
                    disabled={passwordActionLoading}
                    className="w-full"
                  >
                    Regenerate 2FA Code
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleRegenerateRecoveryCodes}
                    disabled={passwordActionLoading}
                    className="w-full"
                  >
                    Regenerate Recovery Codes
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleRemovePasswordLogin}
                    disabled={passwordActionLoading || !authMethods?.has_passkey}
                    className="w-full"
                  >
                    Remove Password Login
                  </Button>
                </div>

                {!authMethods?.has_passkey ? (
                  <p className="text-xs text-muted-foreground">
                    Add a passkey before removing password login.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border p-4">
                <h5 className="text-sm font-medium">Set up Password + 2FA</h5>
                <div className="space-y-2">
                  <Label htmlFor="password-setup-account" className="text-xs">
                    Account password
                  </Label>
                  <Input
                    id="password-setup-account"
                    type="password"
                    value={passwordSetupAccountPassword}
                    onChange={(event) => setPasswordSetupAccountPassword(event.target.value)}
                    placeholder="minimum 12 characters"
                    disabled={passwordSetupLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password-setup-account-confirm" className="text-xs">
                    Confirm account password
                  </Label>
                  <Input
                    id="password-setup-account-confirm"
                    type="password"
                    value={passwordSetupConfirmAccountPassword}
                    onChange={(event) => setPasswordSetupConfirmAccountPassword(event.target.value)}
                    placeholder="confirm account password"
                    disabled={passwordSetupLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password-setup-master" className="text-xs">
                    Master password
                  </Label>
                  <Input
                    id="password-setup-master"
                    type="password"
                    value={passwordSetupMasterPassword}
                    onChange={(event) => setPasswordSetupMasterPassword(event.target.value)}
                    placeholder="your existing master password"
                    disabled={passwordSetupLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password-setup-master-confirm" className="text-xs">
                    Confirm master password
                  </Label>
                  <Input
                    id="password-setup-master-confirm"
                    type="password"
                    value={passwordSetupConfirmMasterPassword}
                    onChange={(event) => setPasswordSetupConfirmMasterPassword(event.target.value)}
                    placeholder="confirm master password"
                    disabled={passwordSetupLoading}
                  />
                </div>

                {passwordSetupError ? (
                  <p className="text-sm text-destructive">{passwordSetupError}</p>
                ) : null}

                <Button
                  variant="accept"
                  onClick={handlePasswordSetupStart}
                  disabled={passwordSetupLoading}
                  className="w-full"
                >
                  {passwordSetupLoading ? "Starting setup..." : "Continue to 2FA setup"}
                </Button>
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Active sessions</h3>
            <p className="text-xs text-muted-foreground">
              Devices where you are currently logged in. Sessions expire after 7 days of inactivity.
            </p>
          </div>

          {loadingSessions ? (
            <p className="text-sm text-muted-foreground">Loading sessions...</p>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "flex items-start justify-between rounded-lg border p-3",
                    session.isCurrent && "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/10"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Monitor className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {parseDeviceInfo(session.deviceInfo)}
                        </span>
                        {session.isCurrent && (
                          <Badge variant="outline" className="text-[10px]">
                            Current
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {session.ipAddress ?? "Unknown IP"} &bull; Created {formatRelativeTime(session.createdAt)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Last active {formatRelativeTime(session.lastActiveAt)}
                      </p>
                    </div>
                  </div>
                  {!session.isCurrent && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleInvalidateSession(session.id)}
                      disabled={invalidatingSessionId === session.id}
                      title="Log out this session"
                    >
                      <LogOut className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {sessions.length > 1 && (
            <Button
              variant="outline"
              className="w-full"
              onClick={handleInvalidateAllOther}
            >
              Log out all other sessions
            </Button>
          )}
        </div>
      </div>
    ),
    security: (
      <div className="space-y-6 py-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Keys</h3>
          <p className="text-xs text-muted-foreground">
            Cryptographic keys that secure your identity and messages.
          </p>
        </div>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4 text-emerald-600" />
                <span className="font-semibold text-sm">Identity Key</span>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono">ML-DSA-65</Badge>
            </div>
            <div className="flex items-start gap-2">
              <div
                className={cn(
                  "flex-1 min-w-0 max-h-32 rounded-md bg-background p-3 font-mono text-xs border shadow-sm min-h-[3rem] flex items-center overflow-y-auto",
                  showKey ? "break-all" : "truncate whitespace-nowrap"
                )}
              >
                {showKey ? identityKey : identityKeyPreview}
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="bg-background shadow-sm"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? "Hide full key" : "View full key"}
                >
                  {showKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="bg-background shadow-sm"
                  onClick={() => navigator.clipboard.writeText(identityKey)}
                  title="Copy key"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Base64 length: {identityKey.length || 0} chars
            </p>
            <p className="mt-3 text-[10px] text-muted-foreground">
              This key publicly identifies you on the network. Friends can verify your identity by comparing this fingerprint.
            </p>
          </div>

          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-sky-600" />
                <span className="font-semibold text-sm">Transport Key</span>
              </div>
              <Badge variant="outline" className="text-[10px] font-mono">ML-KEM-768</Badge>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Used to decrypt incoming payloads. Rotating will update your other signed-in devices.
            </p>
            <div className="mt-3 flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRotateTransportKey}
                disabled={isRotatingTransportKey}
              >
                {isRotatingTransportKey ? "Rotating..." : "Rotate key"}
              </Button>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Last rotated{" "}
              {loadingTransportRotatedAt ? "Loading..." : formatTimestamp(transportRotatedAt)}
            </p>
            {rotateTransportError ? (
              <p className="mt-2 text-[10px] text-destructive">{rotateTransportError}</p>
            ) : null}
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/30 dark:bg-emerald-900/10">
          <Shield className="mt-0.5 h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-emerald-900 dark:text-emerald-100">Zero Knowledge</p>
            <p className="text-[10px] text-emerald-700 dark:text-emerald-300">
              Your private keys never leave your device. The server cannot decrypt your messages.
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-destructive">Danger zone</h3>
          <p className="text-xs text-muted-foreground">
            Permanent actions that remove data from the server.
          </p>
        </div>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-destructive">Delete account</p>
              <p className="text-xs text-muted-foreground">
                Permanently remove your account and server-stored encrypted data. This cannot be undone.
              </p>
            </div>
            <Button
              variant="nuclear"
              className="shrink-0"
              disabled={!isDeleteMatch || isDeleting}
              onClick={handleDeleteAccount}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            <Label htmlFor="delete-confirm" className="text-xs">
              Type your handle to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={deleteConfirm}
              placeholder={deleteLabel || "user@host"}
              onChange={(event) => {
                setDeleteConfirm(event.target.value)
                setDeleteError(null)
              }}
            />
            {deleteError ? (
              <p className="text-xs text-destructive">{deleteError}</p>
            ) : null}
          </div>
        </div>
      </div>
    ),
    notifications: (
      <div className="space-y-6 py-4">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Push Notifications</h3>
            <p className="text-xs text-muted-foreground">
              Get notified when you receive new messages, even when the app is closed.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="push-enabled" className="text-sm">
                Enable push notifications
              </Label>
              <p className="text-xs text-muted-foreground">
                {pushSubscribing
                  ? "Updating subscription..."
                  : pushSubscribed
                    ? "Subscribed to push notifications"
                    : "Not subscribed - enable to subscribe"}
              </p>
            </div>
            <Switch
              id="push-enabled"
              checked={settings.pushNotificationsEnabled}
              disabled={pushSubscribing}
              onCheckedChange={handlePushToggle}
            />
          </div>

          <Separator />

          <div className="space-y-4">
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Notification Content</h4>
              <p className="text-xs text-muted-foreground">
                Control what information is shown in notifications.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="push-sender" className="text-sm">
                  Show sender name
                </Label>
                <p className="text-xs text-muted-foreground">
                  Display who sent the message
                </p>
              </div>
              <Switch
                id="push-sender"
                checked={settings.pushShowSenderName}
                onCheckedChange={(checked) =>
                  updateSettings({ pushShowSenderName: checked })
                }
                disabled={!settings.pushNotificationsEnabled}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="push-content" className="text-sm">
                  Show message preview
                </Label>
                <p className="text-xs text-muted-foreground">
                  Display a preview of the message content
                </p>
              </div>
              <Switch
                id="push-content"
                checked={settings.pushShowContent}
                onCheckedChange={(checked) =>
                  updateSettings({ pushShowContent: checked })
                }
                disabled={!settings.pushNotificationsEnabled}
              />
            </div>

            <div className="rounded-md border border-muted-foreground/20 bg-muted/40 p-2 text-[10px] text-muted-foreground">
              Note: Message previews require your password to be saved (auto-unlock enabled).
              Without a saved password, only sender names can be shown.
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Device Settings</h4>
              <p className="text-xs text-muted-foreground">
                Settings that only apply to this device.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="session-notifications" className="text-sm">
                  Notifications on this device
                </Label>
                <p className="text-xs text-muted-foreground">
                  Disable to silence notifications on this device only
                </p>
              </div>
              <Switch
                id="session-notifications"
                checked={sessionNotifications}
                disabled={loadingSessionNotifications || !settings.pushNotificationsEnabled}
                onCheckedChange={handleSessionNotificationsChange}
              />
            </div>

            <div className="rounded-md border border-muted-foreground/20 bg-muted/40 p-2 text-[10px] text-muted-foreground">
              This setting stays on this device and is not synced to other devices or the server.
            </div>
          </div>
        </div>
      </div>
    ),
    blocking: (
      <div className="space-y-6 py-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <User className="h-4 w-4" />
              Blocked Users
            </h3>
            <p className="text-xs text-muted-foreground">
              Messages from blocked users won&apos;t appear in your chats.
            </p>
          </div>

          {blockedUsers.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No blocked users</p>
          ) : (
            <div className="space-y-2">
              {blockedUsers.map((handle) => (
                <div
                  key={handle}
                  className="flex items-center justify-between rounded-lg border p-2"
                >
                  <span className="text-sm font-mono">{handle}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => unblockUser(handle)}
                    title="Unblock user"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={newBlockedUser}
              onChange={(e) => setNewBlockedUser(e.target.value)}
              placeholder="user@server.com"
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleBlockUser()}
            />
            <Button variant="outline" size="sm" onClick={handleBlockUser}>
              <Ban className="h-4 w-4 mr-1" />
              Block
            </Button>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" />
              Blocked Servers
            </h3>
            <p className="text-xs text-muted-foreground">
              All users from blocked servers won&apos;t appear in your chats.
            </p>
          </div>

          {blockedServers.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No blocked servers</p>
          ) : (
            <div className="space-y-2">
              {blockedServers.map((server) => (
                <div
                  key={server}
                  className="flex items-center justify-between rounded-lg border p-2"
                >
                  <span className="text-sm font-mono">@{server}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => unblockServer(server)}
                    title="Unblock server"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={newBlockedServer}
              onChange={(e) => setNewBlockedServer(e.target.value)}
              placeholder="server.com"
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleBlockServer()}
            />
            <Button variant="outline" size="sm" onClick={handleBlockServer}>
              <Ban className="h-4 w-4 mr-1" />
              Block
            </Button>
          </div>
        </div>

        {blockError ? (
          <p className="text-sm text-destructive">{blockError}</p>
        ) : null}

        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/30 dark:bg-amber-900/10">
          <Shield className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-100">Encrypted Block List</p>
            <p className="text-[10px] text-amber-700 dark:text-amber-300">
              Your block list is encrypted locally. The server cannot see who you&apos;ve blocked.
            </p>
          </div>
        </div>
      </div>
    ),
  }

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent
        className="sm:max-w-[640px] max-h-[85vh] grid-rows-[auto_auto_1fr] overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <ResponsiveModalHeader className="space-y-3">
          <ResponsiveModalTitle className="sr-only">Settings</ResponsiveModalTitle>
          <Breadcrumb>
            <BreadcrumbList className="text-base sm:text-xl font-medium">
              <BreadcrumbItem>
                {activePage ? (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={() => setActivePage(null)}
                      className="text-base sm:text-xl"
                    >
                      Settings
                    </button>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>Settings</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {activePage && activePageInfo ? (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activePageInfo.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : null}
            </BreadcrumbList>
          </Breadcrumb>
          <ResponsiveModalDescription>{dialogDescription}</ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <Separator />
        <div className="min-h-0">
          {activePage ? (
            <ScrollArea className="h-full w-full">
              {settingsPageContent[activePage]}
            </ScrollArea>
          ) : (
            <ScrollArea className="h-full w-full">
              <div className="space-y-4 py-4">
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">Subsettings</h3>
                  <p className="text-xs text-muted-foreground">
                    Choose a section to configure.
                  </p>
                </div>
                <div className="grid gap-3">
                  {settingsPages.map((page) => {
                    const Icon = page.icon
                    return (
                      <button
                        key={page.id}
                        type="button"
                        onClick={() => setActivePage(page.id)}
                        className="group w-full rounded-lg border p-4 text-left transition hover:border-foreground/20 hover:bg-muted/50"
                      >
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 rounded-md border bg-background p-2 text-muted-foreground transition group-hover:text-foreground">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm font-semibold">{page.title}</span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:text-foreground" />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {page.description}
                            </p>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </ScrollArea>
          )}
        </div>

        <Dialog open={Boolean(totpFlow)} onOpenChange={handleTotpFlowChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{totpFlow?.title ?? "Verify authenticator"}</DialogTitle>
              <DialogDescription>{totpFlow?.description ?? ""}</DialogDescription>
            </DialogHeader>
            {totpFlow ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4">
                  <div className="rounded-md border-2 border-white bg-white p-2">
                    <QRCodeSVG value={totpFlow.totpUri} size={180} />
                  </div>
                  <div className="text-xs text-muted-foreground text-center">
                    Manual code: <span className="font-mono text-foreground">{totpFlow.totpSecret}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="totp-flow-code" className="text-xs">
                    Verification code
                  </Label>
                  <Input
                    id="totp-flow-code"
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                  />
                </div>
                {totpFlowError ? (
                  <p className="text-sm text-destructive">{totpFlowError}</p>
                ) : null}
                <DialogFooter>
                  <Button
                    onClick={handleTotpFlowVerify}
                    disabled={totpFlowLoading || totpCode.trim().length < 6}
                  >
                    {totpFlowLoading ? "Verifying..." : "Verify"}
                  </Button>
                </DialogFooter>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        <RecoveryCodesDialog
          open={recoveryModalOpen}
          onOpenChange={handleRecoveryModalChange}
          recoveryCodesText={recoveryCodesText}
          recoveryConfirmed={recoveryConfirmed}
          onRecoveryConfirmedChange={setRecoveryConfirmed}
          onDone={handleRecoveryModalDone}
        />

        <Dialog open={passwordChangeDialogOpen} onOpenChange={handlePasswordChangeDialogChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Change Account Password</DialogTitle>
              <DialogDescription>
                Enter your current password and choose a new password for your account.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password-change-current" className="text-xs">
                  Current password
                </Label>
                <Input
                  id="password-change-current"
                  type="password"
                  value={passwordChangeCurrentPassword}
                  onChange={(event) => setPasswordChangeCurrentPassword(event.target.value)}
                  placeholder="Enter current password"
                  disabled={passwordChangeLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password-change-new" className="text-xs">
                  New password
                </Label>
                <Input
                  id="password-change-new"
                  type="password"
                  value={passwordChangeNewPassword}
                  onChange={(event) => setPasswordChangeNewPassword(event.target.value)}
                  placeholder="Minimum 12 characters"
                  disabled={passwordChangeLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password-change-confirm" className="text-xs">
                  Confirm new password
                </Label>
                <Input
                  id="password-change-confirm"
                  type="password"
                  value={passwordChangeConfirmPassword}
                  onChange={(event) => setPasswordChangeConfirmPassword(event.target.value)}
                  placeholder="Confirm new password"
                  disabled={passwordChangeLoading}
                />
              </div>
              {passwordChangeError ? (
                <p className="text-sm text-destructive">{passwordChangeError}</p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handlePasswordChangeDialogChange(false)}
                  disabled={passwordChangeLoading}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handlePasswordChange}
                  disabled={passwordChangeLoading}
                >
                  {passwordChangeLoading ? "Changing..." : "Change Password"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
