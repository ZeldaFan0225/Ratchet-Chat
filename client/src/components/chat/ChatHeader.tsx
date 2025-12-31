"use client"

import * as React from "react"
import {
  Ban,
  BellOff,
  BellRing,
  ChevronDown,
  ChevronUp,
  Download,
  MoreVertical,
  Phone,
  Search,
  Trash2,
  UserPlus,
  Video,
  X,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { MuteDuration } from "@/lib/mute"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { getContactDisplayName, getContactInitials } from "@/lib/contacts"
import type { Contact } from "@/types/dashboard"

type ChatHeaderProps = {
  activeContact: Contact | null
  typingStatus: Record<string, boolean>
  isChatSearchOpen: boolean
  chatSearchQuery: string
  onChatSearchQueryChange: (query: string) => void
  onChatSearchOpen: () => void
  onChatSearchClose: () => void
  searchMatchCount?: number
  currentSearchIndex?: number
  onSearchNext?: () => void
  onSearchPrev?: () => void
  onShowRecipientInfo: () => void
  onExportChat: () => void
  onDeleteChat: () => void
  onBlockUser: () => void
  onAddContact?: () => void
  showAddContact?: boolean
  onStartCall?: (type: "AUDIO" | "VIDEO") => void
  isCallDisabled?: boolean
  isMuted?: boolean
  onMute?: (duration: MuteDuration) => void
  onUnmute?: () => void
}

export function ChatHeader({
  activeContact,
  typingStatus,
  isChatSearchOpen,
  chatSearchQuery,
  onChatSearchQueryChange,
  onChatSearchOpen,
  onChatSearchClose,
  searchMatchCount = 0,
  currentSearchIndex = 0,
  onSearchNext,
  onSearchPrev,
  onShowRecipientInfo,
  onExportChat,
  onDeleteChat,
  onBlockUser,
  onAddContact,
  showAddContact = false,
  onStartCall,
  isCallDisabled = false,
  isMuted = false,
  onMute,
  onUnmute,
}: ChatHeaderProps) {
  const displayName = activeContact
    ? getContactDisplayName(activeContact)
    : "Select a chat"
  const initials = activeContact ? getContactInitials(activeContact) : ""

  const callMenu = onStartCall ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          disabled={!activeContact || isCallDisabled}
          title="Start call"
        >
          <Phone className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onStartCall("AUDIO")}
          disabled={!activeContact || isCallDisabled}
        >
          <Phone className="mr-2 h-4 w-4" />
          <span>Voice call</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onStartCall("VIDEO")}
          disabled={!activeContact || isCallDisabled}
        >
          <Video className="mr-2 h-4 w-4" />
          <span>Video call</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null
  const callMenuMobile = onStartCall ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          disabled={!activeContact || isCallDisabled}
          title="Start call"
        >
          <Phone className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onStartCall("AUDIO")}
          disabled={!activeContact || isCallDisabled}
        >
          <Phone className="mr-2 h-4 w-4" />
          <span>Voice call</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onStartCall("VIDEO")}
          disabled={!activeContact || isCallDisabled}
        >
          <Video className="mr-2 h-4 w-4" />
          <span>Video call</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null
  const actionButtons = <>{callMenu}</>

  return (
    <header className="flex flex-none flex-col gap-3 border-b bg-background/85 px-3 py-3 backdrop-blur sm:flex-row sm:items-center sm:gap-3 sm:px-5 sm:py-4">
      <div className="flex w-full items-center gap-3">
        <SidebarTrigger className="-ml-1" />
        <div
          className="flex min-w-0 flex-1 items-center gap-3 cursor-pointer transition-opacity hover:opacity-80 -ml-2 pl-2 rounded-md py-1 hover:bg-muted/50"
          onClick={() => activeContact && onShowRecipientInfo()}
        >
          {activeContact && (
            <Avatar className="h-10 w-10 border">
              {activeContact.avatar_filename ? (
                <AvatarImage src={`${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${activeContact.avatar_filename}`} />
              ) : null}
              <AvatarFallback>
                {initials}
              </AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {displayName}
            </p>
            {activeContact ? (
              activeContact.handle && typingStatus[activeContact.handle] ? (
                <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 animate-pulse">
                  Typing...
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Encrypted session</p>
              )
            ) : (
              <p className="text-xs text-muted-foreground">
                Start by adding a username on the left.
              </p>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1 sm:hidden">
          {callMenuMobile}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {activeContact && onAddContact && showAddContact ? (
                <>
                  <DropdownMenuItem onClick={onAddContact}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    <span>Add to contacts</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem
                onClick={onChatSearchOpen}
                disabled={!activeContact}
              >
                <Search className="mr-2 h-4 w-4" />
                <span>Search in chat</span>
              </DropdownMenuItem>
              {activeContact && onMute && onUnmute && (
                <>
                  <DropdownMenuSeparator />
                  {isMuted ? (
                    <DropdownMenuItem onClick={onUnmute}>
                      <BellRing className="mr-2 h-4 w-4" />
                      <span>Unmute Notifications</span>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <BellOff className="mr-2 h-4 w-4" />
                        <span>Mute Notifications</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => onMute("1h")}>
                          1 hour
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onMute("8h")}>
                          8 hours
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onMute("24h")}>
                          24 hours
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onMute("1w")}>
                          1 week
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onMute("forever")}>
                          Forever
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onExportChat}>
                <Download className="mr-2 h-4 w-4" />
                <span>Export Chat</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onBlockUser}
                className="text-destructive focus:text-destructive"
              >
                <Ban className="mr-2 h-4 w-4" />
                <span>Block User</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onDeleteChat}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Delete Chat</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="ml-auto hidden items-center gap-2 sm:flex">
        {isChatSearchOpen ? (
          <div className="flex items-center gap-1">
            <div className="relative w-48 lg:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search in chat..."
                className="h-9 pl-9 pr-3"
                value={chatSearchQuery}
                onChange={(e) => onChatSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    if (e.shiftKey) {
                      onSearchPrev?.()
                    } else {
                      onSearchNext?.()
                    }
                  }
                }}
                autoFocus
              />
            </div>
            <span className="min-w-[3.5rem] text-center text-sm text-muted-foreground">
              {searchMatchCount > 0
                ? `${currentSearchIndex + 1} / ${searchMatchCount}`
                : chatSearchQuery.trim()
                ? "0 results"
                : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onSearchNext}
              disabled={searchMatchCount === 0}
              title="Older match"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onSearchPrev}
              disabled={searchMatchCount === 0}
              title="Newer match"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onChatSearchClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            {actionButtons}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground">
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {activeContact && onAddContact && showAddContact ? (
                  <>
                    <DropdownMenuItem onClick={onAddContact}>
                      <UserPlus className="mr-2 h-4 w-4" />
                      <span>Add to contacts</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  onClick={onChatSearchOpen}
                  disabled={!activeContact}
                >
                  <Search className="mr-2 h-4 w-4" />
                  <span>Search in chat</span>
                </DropdownMenuItem>
                {activeContact && onMute && onUnmute && (
                  <>
                    <DropdownMenuSeparator />
                    {isMuted ? (
                      <DropdownMenuItem onClick={onUnmute}>
                        <BellRing className="mr-2 h-4 w-4" />
                        <span>Unmute Notifications</span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <BellOff className="mr-2 h-4 w-4" />
                          <span>Mute Notifications</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onClick={() => onMute("1h")}>
                            1 hour
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onMute("8h")}>
                            8 hours
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onMute("24h")}>
                            24 hours
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onMute("1w")}>
                            1 week
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onMute("forever")}>
                            Forever
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onExportChat}>
                  <Download className="mr-2 h-4 w-4" />
                  <span>Export Chat</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onBlockUser}
                  className="text-destructive focus:text-destructive"
                >
                  <Ban className="mr-2 h-4 w-4" />
                  <span>Block User</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onDeleteChat}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete Chat</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {isChatSearchOpen ? (
        <div className="w-full sm:hidden">
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search..."
                className="h-9 pl-9 pr-3"
                value={chatSearchQuery}
                onChange={(e) => onChatSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    if (e.shiftKey) {
                      onSearchPrev?.()
                    } else {
                      onSearchNext?.()
                    }
                  }
                }}
                autoFocus
              />
            </div>
            <span className="min-w-[3rem] text-center text-xs text-muted-foreground">
              {searchMatchCount > 0
                ? `${currentSearchIndex + 1}/${searchMatchCount}`
                : chatSearchQuery.trim()
                ? "0"
                : ""}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onSearchNext}
              disabled={searchMatchCount === 0}
              title="Older match"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onSearchPrev}
              disabled={searchMatchCount === 0}
              title="Newer match"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onChatSearchClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  )
}
