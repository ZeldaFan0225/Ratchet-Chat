"use client"

import * as React from "react"
import { Ban, ChevronRight, Copy, Eye, EyeOff, Fingerprint, Key, Lock, LogOut, Monitor, Plus, Server, Shield, Trash2, User } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { useAuth, type SessionInfo, type PasskeyInfo } from "@/context/AuthContext"
import { useBlock } from "@/context/BlockContext"
import { useCall } from "@/context/CallContext"
import { useSettings } from "@/hooks/useSettings"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"

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

type SettingsPage = "privacy" | "access" | "security" | "blocking"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user, publicIdentityKey, deleteAccount, fetchSessions, invalidateSession, invalidateAllOtherSessions, rotateTransportKey, getTransportKeyRotatedAt, fetchPasskeys, addPasskey, removePasskey } = useAuth()
  const { blockedUsers, blockedServers, blockUser, unblockUser, blockServer, unblockServer } = useBlock()
  const { callState } = useCall()
  const { settings, updateSettings } = useSettings()
  const isInActiveCall = callState.status !== "idle" && callState.status !== "ended"
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

  // Block list state
  const [newBlockedUser, setNewBlockedUser] = React.useState("")
  const [newBlockedServer, setNewBlockedServer] = React.useState("")
  const [blockError, setBlockError] = React.useState<string | null>(null)

  const identityKey = publicIdentityKey ?? ""
  const identityKeyPreview = formatKeyPreview(identityKey)

  const deleteLabel = user?.handle ?? user?.username ?? ""
  const isDeleteMatch = deleteLabel !== "" && deleteConfirm.trim() === deleteLabel

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

  React.useEffect(() => {
    if (open) {
      void loadSessions()
      void loadTransportRotation()
      void loadPasskeys()
    }
  }, [open, loadSessions, loadTransportRotation, loadPasskeys])

  React.useEffect(() => {
    if (!open) {
      setDeleteConfirm("")
      setDeleteError(null)
      setIsDeleting(false)
      setRotateTransportError(null)
      setPasskeyError(null)
      setNewPasskeyName("")
      setNewBlockedUser("")
      setNewBlockedServer("")
      setBlockError(null)
      setActivePage(null)
    }
  }, [open])

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
      id: "privacy",
      title: "Privacy",
      description: "Control what others can see.",
      icon: Eye,
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
    privacy: (
      <div className="space-y-6 py-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Messaging</h3>
          <p className="text-xs text-muted-foreground">
            Choose what activity details others can see.
          </p>
        </div>
        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-1">
            <Label htmlFor="typing" className="text-base">Typing Indicator</Label>
            <p className="text-xs text-muted-foreground">
              Show others when you are typing.
            </p>
          </div>
          <Switch
            id="typing"
            checked={settings.showTypingIndicator}
            onCheckedChange={(checked) =>
              updateSettings({ showTypingIndicator: checked })
            }
          />
        </div>

        <div className="flex items-center justify-between space-x-2">
          <div className="space-y-1">
            <Label htmlFor="receipts" className="text-base">Read Receipts</Label>
            <p className="text-xs text-muted-foreground">
              Let others know when you have read their messages.
            </p>
          </div>
          <Switch
            id="receipts"
            checked={settings.sendReadReceipts}
            onCheckedChange={(checked) =>
              updateSettings({ sendReadReceipts: checked })
            }
          />
        </div>
      </div>
    ),
    access: (
      <div className="space-y-8 py-4">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Sign-in methods</h3>
            <p className="text-xs text-muted-foreground">
              Manage passkeys tied to this account.
            </p>
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
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
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
              onClick={handleAddPasskey}
              disabled={addingPasskey}
              className="w-full"
            >
              <Plus className="mr-2 h-4 w-4" />
              {addingPasskey ? "Adding passkey..." : "Add Passkey"}
            </Button>
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
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
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
                  className="h-9 w-9 bg-background shadow-sm"
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
                  className="h-9 w-9 bg-background shadow-sm"
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
              variant="destructive"
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
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
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
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] grid-rows-[auto_auto_1fr] overflow-hidden">
        <DialogHeader className="space-y-3">
          <DialogTitle className="sr-only">Settings</DialogTitle>
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
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
