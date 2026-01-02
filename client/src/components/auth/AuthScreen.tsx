"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { Fingerprint, Key, Lock, User } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"

import { useAuth } from "@/context/AuthContext"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import { getSessionNotificationsEnabled, setSessionNotificationsEnabled } from "@/lib/push"
import { formatRecoveryCodes } from "@/lib/totp"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RecoveryCodesDialog } from "@/components/RecoveryCodesDialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type PasskeyRegisterValues = {
  username: string
  password: string
  confirmPassword: string
}

type PasswordRegisterValues = {
  username: string
  accountPassword: string
  confirmAccountPassword: string
  masterPassword: string
  confirmMasterPassword: string
}

type PasswordLoginValues = {
  username: string
  accountPassword: string
}

type TotpValues = {
  code: string
}

type RecoveryValues = {
  code: string
}

type MasterUnlockValues = {
  masterPassword: string
}

export function AuthScreen() {
  const {
    register: registerUser,
    loginWithPasskey,
    registerWithPassword,
    loginWithPassword,
    verifyTotp,
    verifyRecoveryCode,
    unlockAfter2FA,
    cancelPasswordLogin,
    status,
    capabilities,
  } = useAuth()
  const [activeTab, setActiveTab] = React.useState<"login" | "register">("login")
  const [loginMethod, setLoginMethod] = React.useState<"passkey" | "password">("passkey")
  const [registerMethod, setRegisterMethod] = React.useState<"passkey" | "password">("passkey")
  const [passkeyError, setPasskeyError] = React.useState<string | null>(null)
  const [passkeyLoading, setPasskeyLoading] = React.useState<"login" | "register" | null>(null)
  const [savePasskeyPassword, setSavePasskeyPassword] = React.useState(false)
  const [passwordRegisterError, setPasswordRegisterError] = React.useState<string | null>(null)
  const [passwordRegisterLoading, setPasswordRegisterLoading] = React.useState(false)
  const [passwordTotpLoading, setPasswordTotpLoading] = React.useState(false)
  const [passwordTotpError, setPasswordTotpError] = React.useState<string | null>(null)
  const [passwordRegistration, setPasswordRegistration] = React.useState<{
    totpSecret: string
    totpUri: string
    onVerify: (totpCode: string) => Promise<string[]>
  } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([])
  const [recoveryModalOpen, setRecoveryModalOpen] = React.useState(false)
  const [recoveryConfirmed, setRecoveryConfirmed] = React.useState(false)
  const [passwordLoginError, setPasswordLoginError] = React.useState<string | null>(null)
  const [passwordLoginLoading, setPasswordLoginLoading] = React.useState(false)
  const [totpLoginLoading, setTotpLoginLoading] = React.useState(false)
  const [totpLoginError, setTotpLoginError] = React.useState<string | null>(null)
  const [useRecoveryCode, setUseRecoveryCode] = React.useState(false)
  const [remainingRecoveryCodes, setRemainingRecoveryCodes] = React.useState<number | null>(null)
  const [masterUnlockLoading, setMasterUnlockLoading] = React.useState(false)
  const [masterUnlockError, setMasterUnlockError] = React.useState<string | null>(null)
  const [savePasswordAfter2fa, setSavePasswordAfter2fa] = React.useState(false)
  const [sessionNotifications, setSessionNotifications] = React.useState(true)
  const [postRegisterLogin, setPostRegisterLogin] = React.useState<{
    username: string
    accountPassword: string
  } | null>(null)
  const instanceHost = getInstanceHost()
  const passwordAvailable = capabilities?.password_2fa !== false
  const passwordDisabled = capabilities?.password_2fa === false
  const passwordLoginInProgress = status === "awaiting_2fa" || status === "awaiting_master_password"
  const loginTabValue = passwordLoginInProgress ? "password" : loginMethod
  const recoveryCodesText = React.useMemo(
    () => (recoveryCodes.length > 0 ? formatRecoveryCodes(recoveryCodes) : ""),
    [recoveryCodes]
  )

  React.useEffect(() => {
    if (!passwordAvailable) {
      setLoginMethod("passkey")
      setRegisterMethod("passkey")
    }
  }, [passwordAvailable])

  React.useEffect(() => {
    if (passwordLoginInProgress) {
      setActiveTab("login")
      setLoginMethod("password")
    }
  }, [passwordLoginInProgress])

  React.useEffect(() => {
    if (status === "guest") {
      setPasswordLoginError(null)
      setTotpLoginError(null)
      setMasterUnlockError(null)
      setUseRecoveryCode(false)
      setRemainingRecoveryCodes(null)
      setPostRegisterLogin(null)
    }
  }, [status])

  React.useEffect(() => {
    getSessionNotificationsEnabled().then(setSessionNotifications)
  }, [])

  const handleSessionNotificationsChange = React.useCallback((checked: boolean) => {
    setSessionNotifications(checked)
    void setSessionNotificationsEnabled(checked)
  }, [])

  const validateLocalHandle = React.useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) {
        return "Username is required"
      }
      if (!trimmed.includes("@")) {
        return true
      }
      const parts = splitHandle(trimmed)
      if (!parts) {
        return "Enter a valid handle like alice@host"
      }
      if (!instanceHost) {
        return "Instance host is not configured"
      }
      if (parts.host !== instanceHost) {
        return "Use a local username only"
      }
      return true
    },
    [instanceHost]
  )

  const passkeyRegisterForm = useForm<PasskeyRegisterValues>({
    defaultValues: { username: "", password: "", confirmPassword: "" },
  })

  const passwordRegisterForm = useForm<PasswordRegisterValues>({
    defaultValues: {
      username: "",
      accountPassword: "",
      confirmAccountPassword: "",
      masterPassword: "",
      confirmMasterPassword: "",
    },
  })

  const passwordLoginForm = useForm<PasswordLoginValues>({
    defaultValues: { username: "", accountPassword: "" },
  })

  const passwordTotpSetupForm = useForm<TotpValues>({
    defaultValues: { code: "" },
  })

  const totpLoginForm = useForm<TotpValues>({
    defaultValues: { code: "" },
  })

  const recoveryLoginForm = useForm<RecoveryValues>({
    defaultValues: { code: "" },
  })

  const masterUnlockForm = useForm<MasterUnlockValues>({
    defaultValues: { masterPassword: "" },
  })

  const handleLogin = React.useCallback(async () => {
    setPasskeyError(null)
    setPasskeyLoading("login")
    try {
      await loginWithPasskey()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to login"
      if (message.includes("cancelled") || message.includes("canceled") || message.includes("abort")) {
        setPasskeyError(null)
      } else {
        setPasskeyError(message)
      }
    } finally {
      setPasskeyLoading(null)
    }
  }, [loginWithPasskey])

  const handleRegister = React.useCallback(
    async (values: PasskeyRegisterValues) => {
      setPasskeyError(null)
      if (values.password !== values.confirmPassword) {
        setPasskeyError("Passwords do not match")
        return
      }
      setPasskeyLoading("register")
      try {
        await registerUser(values.username, values.password, savePasskeyPassword)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to register"
        if (message.includes("cancelled") || message.includes("canceled") || message.includes("abort")) {
          setPasskeyError(null)
        } else {
          setPasskeyError(message)
        }
      } finally {
        setPasskeyLoading(null)
      }
    },
    [registerUser, savePasskeyPassword]
  )

  const handlePasswordRegister = React.useCallback(
    async (values: PasswordRegisterValues) => {
      setPasswordRegisterError(null)
      if (values.accountPassword !== values.confirmAccountPassword) {
        setPasswordRegisterError("Account passwords do not match")
        return
      }
      if (values.masterPassword !== values.confirmMasterPassword) {
        setPasswordRegisterError("Master passwords do not match")
        return
      }
      setPasswordRegisterLoading(true)
      try {
        const setup = await registerWithPassword(
          values.username,
          values.accountPassword,
          values.masterPassword
        )
        setPasswordRegistration(setup)
        setPostRegisterLogin({
          username: values.username,
          accountPassword: values.accountPassword,
        })
        passwordTotpSetupForm.reset()
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to start setup"
        setPasswordRegisterError(message)
      } finally {
        setPasswordRegisterLoading(false)
      }
    },
    [registerWithPassword, passwordTotpSetupForm]
  )

  const handlePasswordTotpVerify = React.useCallback(
    async (values: TotpValues) => {
      if (!passwordRegistration) {
        return
      }
      setPasswordTotpError(null)
      setPasswordTotpLoading(true)
      try {
        const codes = await passwordRegistration.onVerify(values.code)
        setRecoveryCodes(codes)
        setRecoveryConfirmed(false)
        setRecoveryModalOpen(true)
        setPasswordRegistration(null)
        passwordRegisterForm.reset()
        passwordTotpSetupForm.reset()
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to verify code"
        setPasswordTotpError(message)
      } finally {
        setPasswordTotpLoading(false)
      }
    },
    [passwordRegistration, passwordRegisterForm, passwordTotpSetupForm]
  )

  const handlePasswordLogin = React.useCallback(
    async (values: PasswordLoginValues) => {
      setPasswordLoginError(null)
      setPasswordLoginLoading(true)
      try {
        await loginWithPassword(values.username, values.accountPassword)
        setUseRecoveryCode(false)
        setRemainingRecoveryCodes(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to login"
        setPasswordLoginError(message)
      } finally {
        setPasswordLoginLoading(false)
      }
    },
    [loginWithPassword]
  )

  const handleVerifyTotp = React.useCallback(
    async (values: TotpValues) => {
      setTotpLoginError(null)
      setTotpLoginLoading(true)
      try {
        await verifyTotp(values.code)
        totpLoginForm.reset()
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid code"
        setTotpLoginError(message)
      } finally {
        setTotpLoginLoading(false)
      }
    },
    [verifyTotp, totpLoginForm]
  )

  const handleVerifyRecoveryCode = React.useCallback(
    async (values: RecoveryValues) => {
      setTotpLoginError(null)
      setTotpLoginLoading(true)
      try {
        const result = await verifyRecoveryCode(values.code)
        setRemainingRecoveryCodes(result.remainingCodes)
        recoveryLoginForm.reset()
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid recovery code"
        setTotpLoginError(message)
      } finally {
        setTotpLoginLoading(false)
      }
    },
    [verifyRecoveryCode, recoveryLoginForm]
  )

  const handleUnlockAfter2fa = React.useCallback(
    async (values: MasterUnlockValues) => {
      setMasterUnlockError(null)
      setMasterUnlockLoading(true)
      try {
        await unlockAfter2FA(values.masterPassword, savePasswordAfter2fa)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to unlock"
        setMasterUnlockError(message)
      } finally {
        setMasterUnlockLoading(false)
      }
    },
    [unlockAfter2FA, savePasswordAfter2fa]
  )

  const handleCancelPasswordLogin = React.useCallback(() => {
    cancelPasswordLogin()
    passwordLoginForm.reset()
    totpLoginForm.reset()
    recoveryLoginForm.reset()
    masterUnlockForm.reset()
    setUseRecoveryCode(false)
    setSavePasswordAfter2fa(false)
    setPostRegisterLogin(null)
  }, [cancelPasswordLogin, passwordLoginForm, totpLoginForm, recoveryLoginForm, masterUnlockForm])

  const handleRecoveryModalChange = React.useCallback(
    (open: boolean) => {
      if (!open && !recoveryConfirmed) {
        return
      }
      setRecoveryModalOpen(open)
    },
    [recoveryConfirmed]
  )

  const handleRecoveryModalDone = React.useCallback(async () => {
    if (!recoveryConfirmed) {
      return
    }
    setRecoveryModalOpen(false)
    setRecoveryConfirmed(false)
    setActiveTab("login")
    setLoginMethod("password")
    if (postRegisterLogin) {
      setPasswordLoginError(null)
      setPasswordLoginLoading(true)
      try {
        await loginWithPassword(
          postRegisterLogin.username,
          postRegisterLogin.accountPassword
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to login"
        setPasswordLoginError(message)
      } finally {
        setPasswordLoginLoading(false)
        setPostRegisterLogin(null)
      }
    }
  }, [recoveryConfirmed, postRegisterLogin, loginWithPassword])

  const passkeyLoginPanel = (
    <>
      <div className="text-sm text-muted-foreground">
        Use your passkey to sign in. Your browser will prompt you to authenticate.
      </div>
      {passkeyError ? (
        <p className="text-destructive text-sm">{passkeyError}</p>
      ) : null}
      <Button
        onClick={handleLogin}
        className="w-full"
        disabled={passkeyLoading === "login"}
      >
        <Fingerprint className="mr-2 h-4 w-4" />
        {passkeyLoading === "login" ? "Authenticating..." : "Sign in with Passkey"}
      </Button>
    </>
  )

  const passwordLoginPanel = (
    <>
      {status === "awaiting_2fa" ? (
        <Form key={useRecoveryCode ? "recovery" : "totp"} {...(useRecoveryCode ? recoveryLoginForm : totpLoginForm)}>
          <form
            onSubmit={(useRecoveryCode ? recoveryLoginForm : totpLoginForm).handleSubmit(
              useRecoveryCode ? handleVerifyRecoveryCode : handleVerifyTotp
            )}
            className="space-y-4"
          >
            <div className="space-y-1">
              <p className="text-sm font-medium">Two-factor authentication</p>
              <p className="text-xs text-muted-foreground">
                Enter the 6-digit code from your authenticator app, or use a recovery code.
              </p>
            </div>
            {useRecoveryCode ? (
              <FormField
                control={recoveryLoginForm.control}
                name="code"
                rules={{ required: "Recovery code is required" }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Recovery code</FormLabel>
                    <FormControl>
                      <Input
                        autoComplete="one-time-code"
                        placeholder="XXXX-XXXX"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={totpLoginForm.control}
                name="code"
                rules={{
                  required: "Code is required",
                  pattern: {
                    value: /^\d{6}$/,
                    message: "Enter a 6-digit code",
                  },
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Authenticator code</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        maxLength={6}
                        autoFocus
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setUseRecoveryCode((prev) => !prev)}
            >
              {useRecoveryCode ? "Use authenticator code instead" : "Use recovery code instead"}
            </Button>
            {totpLoginError ? (
              <p className="text-destructive text-sm">{totpLoginError}</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={totpLoginLoading}>
                {totpLoginLoading ? "Verifying..." : "Verify"}
              </Button>
              <Button type="button" variant="outline" className="w-full" onClick={handleCancelPasswordLogin}>
                Cancel
              </Button>
            </div>
          </form>
        </Form>
      ) : status === "awaiting_master_password" ? (
        <Form {...masterUnlockForm}>
          <form
            onSubmit={masterUnlockForm.handleSubmit(handleUnlockAfter2fa)}
            className="space-y-4"
          >
            <div className="space-y-1">
              <p className="text-sm font-medium">Unlock your keys</p>
              <p className="text-xs text-muted-foreground">
                Your master password decrypts your private keys locally.
              </p>
            </div>
            <FormField
              control={masterUnlockForm.control}
              name="masterPassword"
              rules={{
                required: "Master password is required",
                minLength: {
                  value: 12,
                  message: "Password must be at least 12 characters",
                },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Master password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="Enter your master password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-center space-x-2">
              <Switch
                id="save-master-password"
                checked={savePasswordAfter2fa}
                onCheckedChange={setSavePasswordAfter2fa}
              />
              <Label htmlFor="save-master-password" className="text-sm">
                Remember password on this device
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <Switch
                id="session-notifications"
                checked={sessionNotifications}
                onCheckedChange={handleSessionNotificationsChange}
              />
              <Label htmlFor="session-notifications" className="text-sm">
                Enable notifications on this device
              </Label>
            </div>
            {remainingRecoveryCodes !== null ? (
              <p className="text-xs text-muted-foreground">
                Recovery codes remaining: {remainingRecoveryCodes}
              </p>
            ) : null}
            {masterUnlockError ? (
              <p className="text-destructive text-sm">{masterUnlockError}</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" className="w-full" disabled={masterUnlockLoading}>
                {masterUnlockLoading ? "Unlocking..." : "Unlock"}
              </Button>
              <Button type="button" variant="outline" className="w-full" onClick={handleCancelPasswordLogin}>
                Cancel
              </Button>
            </div>
          </form>
        </Form>
      ) : (
        <Form {...passwordLoginForm}>
          <form
            onSubmit={passwordLoginForm.handleSubmit(handlePasswordLogin)}
            className="space-y-4"
          >
            <FormField
              control={passwordLoginForm.control}
              name="username"
              rules={{
                required: "Username is required",
                validate: validateLocalHandle,
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="username"
                      placeholder="alice"
                      {...field}
                    />
                  </FormControl>
                  {instanceHost ? (
                    <p className="text-xs text-muted-foreground">
                      Handle: {normalizeHandle(field.value || "alice")}
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={passwordLoginForm.control}
              name="accountPassword"
              rules={{ required: "Password is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="Enter your account password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {passwordLoginError ? (
              <p className="text-destructive text-sm">{passwordLoginError}</p>
            ) : null}
            <Button type="submit" className="w-full" disabled={passwordLoginLoading}>
              {passwordLoginLoading ? "Checking password..." : "Continue"}
            </Button>
          </form>
        </Form>
      )}
    </>
  )

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg border-border bg-card/90 shadow-xl backdrop-blur">
        <CardHeader>
          <CardTitle className="text-2xl">Ratchet-Chat</CardTitle>
          <CardDescription>
            Zero-knowledge access. Keys stay in your browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "login" | "register")} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
            </TabsList>
            <TabsContent value="login" className="space-y-4">
              {passwordAvailable ? (
                <Tabs value={loginTabValue} onValueChange={(value) => setLoginMethod(value as "passkey" | "password")} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="passkey" disabled={passwordLoginInProgress}>Passkey</TabsTrigger>
                    <TabsTrigger value="password">Password</TabsTrigger>
                  </TabsList>
                  <TabsContent value="passkey" className="space-y-4">
                    {passkeyLoginPanel}
                  </TabsContent>
                  <TabsContent value="password" className="space-y-4">
                    {passwordLoginPanel}
                  </TabsContent>
                </Tabs>
              ) : passwordLoginInProgress ? (
                <div className="space-y-4">{passwordLoginPanel}</div>
              ) : (
                <div className="space-y-4">
                  {passkeyLoginPanel}
                  {passwordDisabled ? (
                    <p className="text-xs text-muted-foreground">
                      Password login is disabled on this server.
                    </p>
                  ) : null}
                </div>
              )}
            </TabsContent>
            <TabsContent value="register" className="space-y-4">
              {passwordAvailable ? (
                <Tabs value={registerMethod} onValueChange={(value) => setRegisterMethod(value as "passkey" | "password")} className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="passkey">Passkey</TabsTrigger>
                    <TabsTrigger value="password">Password + 2FA</TabsTrigger>
                  </TabsList>
                  <TabsContent value="passkey">
                    <Form {...passkeyRegisterForm}>
                      <form
                        onSubmit={passkeyRegisterForm.handleSubmit(handleRegister)}
                        className="space-y-4"
                      >
                        <FormField
                          control={passkeyRegisterForm.control}
                          name="username"
                          rules={{
                            required: "Username is required",
                            validate: validateLocalHandle,
                          }}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Username</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="username"
                                  placeholder="alice"
                                  {...field}
                                />
                              </FormControl>
                              {instanceHost ? (
                                <p className="text-xs text-muted-foreground">
                                  Handle: {normalizeHandle(field.value || "alice")}
                                </p>
                              ) : null}
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={passkeyRegisterForm.control}
                          name="password"
                          rules={{
                            required: "Password is required",
                            minLength: {
                              value: 12,
                              message: "Password must be at least 12 characters",
                            },
                          }}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Master password</FormLabel>
                              <FormControl>
                                <Input
                                  type="password"
                                  autoComplete="new-password"
                                  placeholder="minimum 12 characters"
                                  {...field}
                                />
                              </FormControl>
                              <p className="text-xs text-muted-foreground">
                                Used to encrypt your private keys. Choose a strong, unique password.
                              </p>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={passkeyRegisterForm.control}
                          name="confirmPassword"
                          rules={{
                            required: "Please confirm your password",
                            validate: (value) =>
                              value === passkeyRegisterForm.watch("password") || "Passwords do not match",
                          }}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Confirm password</FormLabel>
                              <FormControl>
                                <Input
                                  type="password"
                                  autoComplete="new-password"
                                  placeholder="confirm your password"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <div className="flex items-center space-x-2">
                          <Switch
                            id="save-password"
                            checked={savePasskeyPassword}
                            onCheckedChange={setSavePasskeyPassword}
                          />
                          <Label htmlFor="save-password" className="text-sm">
                            Remember password on this device
                          </Label>
                        </div>
                        {!savePasskeyPassword && (
                          <p className="text-xs text-muted-foreground">
                            You&apos;ll need to enter your password each time you sign in.
                          </p>
                        )}
                        {passkeyError ? (
                          <p className="text-destructive text-sm">{passkeyError}</p>
                        ) : null}
                        <Button type="submit" className="w-full" disabled={passkeyLoading === "register"}>
                          <Key className="mr-2 h-4 w-4" />
                          {passkeyLoading === "register" ? "Creating passkey..." : "Create Account with Passkey"}
                        </Button>
                      </form>
                    </Form>
                  </TabsContent>
                  <TabsContent value="password" className="space-y-4">
                    {passwordRegistration ? (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Set up your authenticator</p>
                          <p className="text-xs text-muted-foreground">
                            Scan the QR code in your authenticator app, then enter the 6-digit code to verify.
                          </p>
                        </div>
                        <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4">
                        <div className="rounded-md border-2 border-white bg-white p-2">
                          <QRCodeSVG value={passwordRegistration.totpUri} size={180} />
                        </div>
                          <div className="text-xs text-muted-foreground text-center">
                            Manual code: <span className="font-mono text-foreground">{passwordRegistration.totpSecret}</span>
                          </div>
                        </div>
                        <Form {...passwordTotpSetupForm}>
                          <form
                            onSubmit={passwordTotpSetupForm.handleSubmit(handlePasswordTotpVerify)}
                            className="space-y-4"
                          >
                            <FormField
                              control={passwordTotpSetupForm.control}
                              name="code"
                              rules={{
                                required: "Code is required",
                                pattern: {
                                  value: /^\d{6}$/,
                                  message: "Enter a 6-digit code",
                                },
                              }}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Verification code</FormLabel>
                                  <FormControl>
                                    <Input
                                      autoComplete="one-time-code"
                                      placeholder="123456"
                                      {...field}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            {passwordTotpError ? (
                              <p className="text-destructive text-sm">{passwordTotpError}</p>
                            ) : null}
                            <Button type="submit" className="w-full" disabled={passwordTotpLoading}>
                              {passwordTotpLoading ? "Verifying..." : "Verify and finish"}
                            </Button>
                          </form>
                        </Form>
                      </div>
                    ) : (
                      <Form {...passwordRegisterForm}>
                        <form
                          onSubmit={passwordRegisterForm.handleSubmit(handlePasswordRegister)}
                          className="space-y-4"
                        >
                          <FormField
                            control={passwordRegisterForm.control}
                            name="username"
                            rules={{
                              required: "Username is required",
                              validate: validateLocalHandle,
                            }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Username</FormLabel>
                                <FormControl>
                                  <Input
                                    autoComplete="username"
                                    placeholder="alice"
                                    {...field}
                                  />
                                </FormControl>
                                {instanceHost ? (
                                  <p className="text-xs text-muted-foreground">
                                    Handle: {normalizeHandle(field.value || "alice")}
                                  </p>
                                ) : null}
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={passwordRegisterForm.control}
                            name="accountPassword"
                            rules={{
                              required: "Account password is required",
                              minLength: {
                                value: 12,
                                message: "Password must be at least 12 characters",
                              },
                            }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Account password</FormLabel>
                                <FormControl>
                                  <Input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="minimum 12 characters"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={passwordRegisterForm.control}
                            name="confirmAccountPassword"
                            rules={{
                              required: "Please confirm your account password",
                              validate: (value) =>
                                value === passwordRegisterForm.watch("accountPassword") || "Passwords do not match",
                            }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Confirm account password</FormLabel>
                                <FormControl>
                                  <Input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="confirm account password"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={passwordRegisterForm.control}
                            name="masterPassword"
                            rules={{
                              required: "Master password is required",
                              minLength: {
                                value: 12,
                                message: "Password must be at least 12 characters",
                              },
                            }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Master password</FormLabel>
                                <FormControl>
                                  <Input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="minimum 12 characters"
                                    {...field}
                                  />
                                </FormControl>
                                <p className="text-xs text-muted-foreground">
                                  Used to encrypt your private keys locally. It never leaves your device.
                                </p>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={passwordRegisterForm.control}
                            name="confirmMasterPassword"
                            rules={{
                              required: "Please confirm your master password",
                              validate: (value) =>
                                value === passwordRegisterForm.watch("masterPassword") || "Passwords do not match",
                            }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Confirm master password</FormLabel>
                                <FormControl>
                                  <Input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder="confirm master password"
                                    {...field}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          {passwordRegisterError ? (
                            <p className="text-destructive text-sm">{passwordRegisterError}</p>
                          ) : null}
                          <Button type="submit" className="w-full" disabled={passwordRegisterLoading}>
                            {passwordRegisterLoading ? "Starting setup..." : "Continue to 2FA setup"}
                          </Button>
                        </form>
                      </Form>
                    )}
                  </TabsContent>
                </Tabs>
              ) : (
                <Form {...passkeyRegisterForm}>
                  <form
                    onSubmit={passkeyRegisterForm.handleSubmit(handleRegister)}
                    className="space-y-4"
                  >
                    <FormField
                      control={passkeyRegisterForm.control}
                      name="username"
                      rules={{
                        required: "Username is required",
                        validate: validateLocalHandle,
                      }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Username</FormLabel>
                          <FormControl>
                            <Input
                              autoComplete="username"
                              placeholder="alice"
                              {...field}
                            />
                          </FormControl>
                          {instanceHost ? (
                            <p className="text-xs text-muted-foreground">
                              Handle: {normalizeHandle(field.value || "alice")}
                            </p>
                          ) : null}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={passkeyRegisterForm.control}
                      name="password"
                      rules={{
                        required: "Password is required",
                        minLength: {
                          value: 12,
                          message: "Password must be at least 12 characters",
                        },
                      }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Master password</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              autoComplete="new-password"
                              placeholder="minimum 12 characters"
                              {...field}
                            />
                          </FormControl>
                          <p className="text-xs text-muted-foreground">
                            Used to encrypt your private keys. Choose a strong, unique password.
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={passkeyRegisterForm.control}
                      name="confirmPassword"
                      rules={{
                        required: "Please confirm your password",
                        validate: (value) =>
                          value === passkeyRegisterForm.watch("password") || "Passwords do not match",
                      }}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Confirm password</FormLabel>
                          <FormControl>
                            <Input
                              type="password"
                              autoComplete="new-password"
                              placeholder="confirm your password"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="flex items-center space-x-2">
                      <Switch
                        id="save-password"
                        checked={savePasskeyPassword}
                        onCheckedChange={setSavePasskeyPassword}
                      />
                      <Label htmlFor="save-password" className="text-sm">
                        Remember password on this device
                      </Label>
                    </div>
                    {!savePasskeyPassword && (
                      <p className="text-xs text-muted-foreground">
                        You&apos;ll need to enter your password each time you sign in.
                      </p>
                    )}
                    {passkeyError ? (
                      <p className="text-destructive text-sm">{passkeyError}</p>
                    ) : null}
                    <Button type="submit" className="w-full" disabled={passkeyLoading === "register"}>
                      <Key className="mr-2 h-4 w-4" />
                      {passkeyLoading === "register" ? "Creating passkey..." : "Create Account with Passkey"}
                    </Button>
                  </form>
                </Form>
              )}
            </TabsContent>
          </Tabs>
          <ScrollArea className="h-28 rounded-md border border-border bg-muted/70 p-3 text-xs text-muted-foreground">
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Fingerprint className="h-3.5 w-3.5" />
                <span>Passkeys provide phishing-resistant authentication.</span>
              </div>
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                <span>Master password encrypts keys locally; never transmitted.</span>
              </div>
              <div className="flex items-center gap-2">
                <User className="h-3.5 w-3.5" />
                <span>Private keys stay encrypted at rest on your device.</span>
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <RecoveryCodesDialog
        open={recoveryModalOpen}
        onOpenChange={handleRecoveryModalChange}
        recoveryCodesText={recoveryCodesText}
        recoveryConfirmed={recoveryConfirmed}
        onRecoveryConfirmedChange={setRecoveryConfirmed}
        onDone={handleRecoveryModalDone}
      />
    </div>
  )
}
