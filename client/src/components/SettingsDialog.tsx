"use client"

import * as React from "react"
import { Copy, Eye, EyeOff, Fingerprint, Lock, Shield } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/context/AuthContext"
import { useSettings } from "@/hooks/useSettings"
import { getIdentityPublicKey } from "@/lib/crypto"
import { Badge } from "@/components/ui/badge"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { user, identityPrivateKey } = useAuth()
  const { settings, updateSettings } = useSettings()
  const [showKey, setShowKey] = React.useState(false)

  const identityKey = React.useMemo(() => {
    if (!identityPrivateKey) return ""
    return getIdentityPublicKey(identityPrivateKey)
  }, [identityPrivateKey])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage your privacy and security preferences.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="privacy" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="privacy">Privacy</TabsTrigger>
            <TabsTrigger value="security">Identity & Keys</TabsTrigger>
          </TabsList>
          
          <TabsContent value="privacy" className="space-y-4 py-4">
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
          </TabsContent>

          <TabsContent value="security" className="space-y-4 py-4">
            <div className="rounded-lg border bg-muted/50 p-4">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-emerald-600" />
                  <span className="font-semibold text-sm">Identity Key</span>
                </div>
                <Badge variant="outline" className="text-[10px] font-mono">Ed25519</Badge>
              </div>
              <div className="flex items-start gap-2">
                <div className="flex-1 rounded-md bg-background p-3 font-mono text-xs break-all border shadow-sm min-h-[3rem] flex items-center">
                  {showKey ? identityKey : "•".repeat(identityKey.length || 44)}
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 bg-background shadow-sm"
                    onClick={() => setShowKey(!showKey)}
                    title={showKey ? "Hide key" : "View key"}
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
              <p className="mt-3 text-[10px] text-muted-foreground">
                This key publicly identifies you on the network. Friends can verify your identity by comparing this fingerprint.
              </p>
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
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
