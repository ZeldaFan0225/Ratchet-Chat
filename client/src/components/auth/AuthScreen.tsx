"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { Lock, User } from "lucide-react"

import { useAuth } from "@/context/AuthContext"
import { getInstanceHost, normalizeHandle, splitHandle } from "@/lib/handles"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type AuthValues = {
  username: string
  password: string
}

export function AuthScreen() {
  const { register: registerUser, login } = useAuth()
  const [authError, setAuthError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState<"login" | "register" | null>(null)
  const instanceHost = getInstanceHost()
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

  const loginForm = useForm<AuthValues>({
    defaultValues: { username: "", password: "" },
  })
  const registerForm = useForm<AuthValues>({
    defaultValues: { username: "", password: "" },
  })

  const handleLogin = React.useCallback(
    async (values: AuthValues) => {
      setAuthError(null)
      setLoading("login")
      try {
        await login(values.username, values.password)
      } catch (error) {
        setAuthError(
          error instanceof Error ? error.message : "Unable to login"
        )
      } finally {
        setLoading(null)
      }
    },
    [login]
  )

  const handleRegister = React.useCallback(
    async (values: AuthValues) => {
      setAuthError(null)
      setLoading("register")
      try {
        await registerUser(values.username, values.password)
      } catch (error) {
        setAuthError(
          error instanceof Error ? error.message : "Unable to register"
        )
      } finally {
        setLoading(null)
      }
    },
    [registerUser]
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
          <Tabs defaultValue="login" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
            </TabsList>
            <TabsContent value="login">
              <Form {...loginForm}>
                <form
                  onSubmit={loginForm.handleSubmit(handleLogin)}
                  className="space-y-4"
                >
                  <FormField
                    control={loginForm.control}
                    name="username"
                    rules={{
                      required: "Username is required",
                      validate: validateLocalHandle,
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username or handle (local)</FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="username"
                            placeholder="alice or alice@host"
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
                    control={loginForm.control}
                    name="password"
                    rules={{ required: "Password is required" }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="current-password"
                            placeholder="••••••••••••"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {authError ? (
                    <p className="text-destructive text-sm">{authError}</p>
                  ) : null}
                  <Button type="submit" className="w-full" disabled={loading === "login"}>
                    {loading === "login" ? "Decrypting keys..." : "Unlock"}
                  </Button>
                </form>
              </Form>
            </TabsContent>
            <TabsContent value="register">
              <Form {...registerForm}>
                <form
                  onSubmit={registerForm.handleSubmit(handleRegister)}
                  className="space-y-4"
                >
                  <FormField
                    control={registerForm.control}
                    name="username"
                    rules={{
                      required: "Username is required",
                      validate: validateLocalHandle,
                    }}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username or handle (local)</FormLabel>
                        <FormControl>
                          <Input
                            autoComplete="username"
                            placeholder="new-handle or new-handle@host"
                            {...field}
                          />
                        </FormControl>
                        {instanceHost ? (
                          <p className="text-xs text-muted-foreground">
                            Handle: {normalizeHandle(field.value || "new-handle")}
                          </p>
                        ) : null}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={registerForm.control}
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
                        <FormLabel>Password</FormLabel>
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
                  {authError ? (
                    <p className="text-destructive text-sm">{authError}</p>
                  ) : null}
                  <Button type="submit" className="w-full" disabled={loading === "register"}>
                    {loading === "register" ? "Sealing keys..." : "Create Account"}
                  </Button>
                </form>
              </Form>
            </TabsContent>
          </Tabs>
          <ScrollArea className="h-28 rounded-md border border-border bg-muted/70 p-3 text-xs text-muted-foreground">
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                <span>Master key derived locally; never transmitted.</span>
              </div>
              <div className="flex items-center gap-2">
                <User className="h-3.5 w-3.5" />
                <span>Private keys stay encrypted at rest.</span>
              </div>
              <div className="flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                <span>Server only sees auth hashes + encrypted keys.</span>
              </div>
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}
