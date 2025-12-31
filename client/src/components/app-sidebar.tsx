"use client"

import * as React from "react"
import { BellOff, ChevronDown, Inbox, Search, Settings, ShieldCheck, UserPlus } from "lucide-react"

import { useAuth } from "@/context/AuthContext"
import { useSettings } from "@/hooks/useSettings"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { NavUser } from "@/components/nav-user"
import { getInstanceHost } from "@/lib/handles"
import { AppInfoDialog } from "@/components/AppInfoDialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

export type ConversationPreview = {
  id: string
  uid: string
  name: string
  handle: string
  lastMessage: string
  lastTimestamp: string
  unread: number
  avatar?: string
  avatarUrl?: string
  foundMessageId?: string
  isMessageRequest?: boolean
  isMuted?: boolean
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  conversations: ConversationPreview[]
  messageRequests: ConversationPreview[]
  activeId: string
  onSelectConversation: (id: string, messageId?: string) => void
  onStartChat: (handle: string) => void
  onLogout: () => void
  startError?: string | null
  isBusy?: boolean
  searchQuery: string
  onSearchChange: (query: string) => void
}

export function AppSidebar({
  conversations,
  messageRequests,
  activeId,
  onSelectConversation,
  onStartChat,
  onLogout,
  startError,
  isBusy,
  searchQuery,
  onSearchChange,
  ...props
}: AppSidebarProps) {
  const { user } = useAuth()
  const { settings } = useSettings()
  const { isMobile, setOpenMobile } = useSidebar()
  const [newChat, setNewChat] = React.useState("")
  const [requestsOpen, setRequestsOpen] = React.useState(true)
  const instanceHost = getInstanceHost()
  const trimmedNewChat = newChat.trim()
  const requestCount = messageRequests.length
  const totalUnreadRequests = messageRequests.reduce((sum, r) => sum + r.unread, 0)
  const displayName =
    settings.displayName?.trim() || user?.username || user?.handle || "User"

  return (
    <Sidebar collapsible="offcanvas" className="border-r bg-sidebar" {...props}>
      <SidebarHeader className="gap-3 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <AppInfoDialog>
            <button
              type="button"
              className="flex items-center gap-3 rounded-md px-1 py-1 text-left transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Open app info"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--theme-accent)] text-white shadow-sm">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="leading-tight group-data-[collapsible=icon]:hidden">
                <p className="text-sm font-semibold">Ratchet-Chat</p>
                <p className="text-xs text-muted-foreground">E2EE Secure</p>
              </div>
            </button>
          </AppInfoDialog>
        </div>
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="text-muted-foreground absolute left-3 top-2.5 h-4 w-4" />
          <SidebarInput
            placeholder="Search chats"
            className="pl-9"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <form
          className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/50 px-2 py-1.5 group-data-[collapsible=icon]:hidden"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newChat.trim()) {
              return
            }
            onStartChat(newChat.trim())
            setNewChat("")
          }}
        >
          <UserPlus className="h-4 w-4 text-[var(--theme-accent)]" />
          <SidebarInput
            placeholder="Recipient ID (user@host)"
            className="h-7 border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
            value={newChat}
            onChange={(event) => setNewChat(event.target.value)}
          />
          <Button size="icon-sm" type="submit" disabled={isBusy}>
            <span className="text-xs">Go</span>
          </Button>
        </form>
        {instanceHost && trimmedNewChat && !trimmedNewChat.includes("@") ? (
          <p className="text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            Recipient ID: {trimmedNewChat}@{instanceHost}
          </p>
        ) : null}
        {startError ? (
          <p className="text-xs text-destructive group-data-[collapsible=icon]:hidden">{startError}</p>
        ) : null}
      </SidebarHeader>
      <SidebarContent className="px-2">
        {requestCount > 0 && (
          <Collapsible
            open={requestsOpen}
            onOpenChange={setRequestsOpen}
            className="group/requests"
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 transition group-data-[collapsible=icon]:hidden">
              <div className="flex items-center gap-2">
                <Inbox className="h-4 w-4 text-amber-500" />
                <span>Message Requests</span>
                {totalUnreadRequests > 0 && (
                  <span className="min-w-[20px] rounded-full bg-amber-500 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
                    {totalUnreadRequests}
                  </span>
                )}
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  requestsOpen && "rotate-180"
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="group-data-[collapsible=icon]:hidden">
              <SidebarMenu className="max-w-full mt-1">
                {messageRequests.map((request) => (
                  <SidebarMenuItem key={request.uid}>
                    <SidebarMenuButton
                      className="h-auto w-full overflow-hidden items-start gap-3 rounded-xl px-3 py-3 border border-dashed border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20 data-[active=true]:bg-amber-100 dark:data-[active=true]:bg-amber-900/30 data-[active=true]:border-amber-400"
                      isActive={activeId === request.id}
                      onClick={() => {
                        onSelectConversation(request.id, request.foundMessageId)
                        if (isMobile) {
                          setOpenMobile(false)
                        }
                      }}
                    >
                      <div className="relative mt-0.5 shrink-0">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={request.avatarUrl || request.avatar || undefined} />
                          <AvatarFallback>
                            {request.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <p className="truncate text-sm font-semibold">
                              {request.name}
                            </p>
                            <span className="shrink-0 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-semibold text-white uppercase">
                              Request
                            </span>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {request.lastTimestamp}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <p
                            className="truncate text-xs text-muted-foreground flex-1"
                            title={request.lastMessage}
                          >
                            {request.lastMessage}
                          </p>
                          {request.unread > 0 && (
                            <span className="shrink-0 min-w-[20px] rounded-full bg-amber-500 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
                              {request.unread}
                            </span>
                          )}
                        </div>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </CollapsibleContent>
          </Collapsible>
        )}
        <SidebarGroup>
          <SidebarGroupContent>
            <ScrollArea className="h-[calc(100svh-220px)] pr-2 w-full">
              <SidebarMenu className="max-w-full">
                {conversations.length === 0 && messageRequests.length === 0 ? (
                  <SidebarMenuItem>
                    <div className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                      {searchQuery
                        ? "No chats found."
                        : "No chats yet. Add a handle above to begin."}
                    </div>
                  </SidebarMenuItem>
                ) : (
                  conversations.map((conversation) => (
                    <SidebarMenuItem key={conversation.uid}>
                      <SidebarMenuButton
                        className="h-auto w-full overflow-hidden items-start gap-3 rounded-xl px-3 py-3 data-[active=true]:bg-[var(--theme-accent-active-bg)] data-[active=true]:text-[var(--theme-accent-active-text)]"
                        isActive={activeId === conversation.id && !conversation.foundMessageId}
                        onClick={() => {
                          onSelectConversation(conversation.id, conversation.foundMessageId)
                          if (isMobile) {
                            setOpenMobile(false)
                          }
                        }}
                      >
                        <div className="relative mt-0.5 shrink-0">
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={conversation.avatarUrl || conversation.avatar || undefined} />
                            <AvatarFallback>
                              {conversation.name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        </div>
                        <div className="min-w-0 flex-1 space-y-1 group-data-[collapsible=icon]:hidden">
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <div className="flex items-center gap-1.5 flex-1 min-w-0">
                              <p className="truncate text-sm font-semibold flex-1">
                                {conversation.name}
                              </p>
                              {conversation.isMuted && (
                                <BellOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              )}
                            </div>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {conversation.lastTimestamp}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 min-w-0">
                            <p 
                              className="truncate text-xs text-muted-foreground flex-1"
                              title={conversation.lastMessage}
                            >
                              {conversation.foundMessageId && <span className="font-semibold text-[var(--theme-accent)] mr-1">Found:</span>}
                              {conversation.lastMessage}
                            </p>
                            {conversation.unread > 0 && !conversation.foundMessageId ? (
                              <span className="shrink-0 min-w-[20px] rounded-full bg-[var(--theme-accent)] px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
                                {conversation.unread}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                )}
              </SidebarMenu>
            </ScrollArea>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <NavUser
          user={{
            name: displayName,
            email: user?.handle ?? "user@ratchet",
            avatar: "",
          }}
          onLogout={onLogout}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
