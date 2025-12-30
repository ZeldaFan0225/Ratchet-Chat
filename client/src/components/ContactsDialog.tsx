"use client"

import * as React from "react"
import { Ban, MessageSquare, Plus, Trash2, Search, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"
import { RecipientInfoDialog } from "@/components/RecipientInfoDialog"
import { useContacts } from "@/context/ContactsContext"
import { useBlock } from "@/context/BlockContext"
import { getContactDisplayName, getContactInitials } from "@/lib/contacts"
import { splitHandle } from "@/lib/handles"
import type { Contact } from "@/types/dashboard"
import { OPEN_CONTACT_CHAT_EVENT, type OpenContactChatDetail } from "@/lib/events"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")

type Section = {
  id: string
  label: string
  indexKey: string
  contacts: Contact[]
}

export function ContactsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { contacts, isLoading, addContactByHandle, removeContact } = useContacts()
  const { blockUser } = useBlock()
  const [groupByServer, setGroupByServer] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [newHandle, setNewHandle] = React.useState("")
  const [addError, setAddError] = React.useState<string | null>(null)
  const [isAdding, setIsAdding] = React.useState(false)
  const [selectedContact, setSelectedContact] = React.useState<Contact | null>(null)
  const [showContactInfo, setShowContactInfo] = React.useState(false)
  const sectionRefs = React.useRef(new Map<string, HTMLDivElement | null>())

  React.useEffect(() => {
    if (!open) {
      setQuery("")
      setNewHandle("")
      setAddError(null)
      setGroupByServer(false)
    }
  }, [open])


  const filteredContacts = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return contacts
    return contacts.filter((contact) => {
      const handle = contact.handle.toLowerCase()
      const username = (contact.username ?? "").toLowerCase()
      const nickname = (contact.nickname ?? "").toLowerCase()
      const displayName = getContactDisplayName(contact).toLowerCase()
      const host = (contact.host ?? "").toLowerCase()
      return (
        handle.includes(needle) ||
        username.includes(needle) ||
        nickname.includes(needle) ||
        displayName.includes(needle) ||
        host.includes(needle)
      )
    })
  }, [contacts, query])

  const sections = React.useMemo<Section[]>(() => {
    if (filteredContacts.length === 0) {
      return []
    }
    if (groupByServer) {
      const map = new Map<string, Contact[]>()
      for (const contact of filteredContacts) {
        const host =
          contact.host ||
          splitHandle(contact.handle)?.host ||
          "unknown"
        const key = host.toLowerCase()
        const existing = map.get(key) ?? []
        existing.push(contact)
        map.set(key, existing)
      }
      return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([host, items]) => {
          const firstChar = host[0]?.toUpperCase() ?? "#"
          const indexKey = ALPHABET.includes(firstChar) ? firstChar : "#"
          return {
            id: `server:${host}`,
            label: host,
            indexKey,
            contacts: items.sort((a, b) =>
              getContactDisplayName(a).localeCompare(getContactDisplayName(b))
            ),
          }
        })
    }
    const map = new Map<string, Contact[]>()
    for (const contact of filteredContacts) {
      const labelSource = getContactDisplayName(contact)
      const firstChar = labelSource.trim()[0]?.toUpperCase() ?? "#"
      const key = ALPHABET.includes(firstChar) ? firstChar : "#"
      const existing = map.get(key) ?? []
      existing.push(contact)
      map.set(key, existing)
    }
    const ordered = [...ALPHABET, "#"]
    return ordered
      .filter((letter) => map.has(letter))
      .map((letter) => ({
        id: `letter:${letter}`,
        label: letter,
        indexKey: letter,
        contacts: (map.get(letter) ?? []).sort((a, b) =>
          getContactDisplayName(a).localeCompare(getContactDisplayName(b))
        ),
      }))
  }, [filteredContacts, groupByServer])

  React.useEffect(() => {
    sectionRefs.current = new Map()
  }, [sections])

  const indexLookup = React.useMemo(() => {
    const lookup = new Map<string, string>()
    for (const section of sections) {
      if (!lookup.has(section.indexKey)) {
        lookup.set(section.indexKey, section.id)
      }
    }
    return lookup
  }, [sections])

  const handleIndexClick = React.useCallback((letter: string) => {
    const sectionId = indexLookup.get(letter)
    if (!sectionId) return
    const target = sectionRefs.current.get(sectionId)
    target?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [indexLookup])

  const handleAddContact = React.useCallback(async () => {
    const trimmed = newHandle.trim()
    if (!trimmed) {
      setAddError("Enter a handle like user@server.com")
      return
    }
    setAddError(null)
    setIsAdding(true)
    try {
      await addContactByHandle(trimmed)
      setNewHandle("")
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Unable to add contact")
    } finally {
      setIsAdding(false)
    }
  }, [addContactByHandle, newHandle])

  const handleSelectContact = React.useCallback((contact: Contact) => {
    setSelectedContact(contact)
    setShowContactInfo(true)
  }, [])

  const handleSendMessage = React.useCallback(
    (contact: Contact) => {
      if (typeof window === "undefined") return
      window.dispatchEvent(
        new CustomEvent<OpenContactChatDetail>(OPEN_CONTACT_CHAT_EVENT, {
          detail: { handle: contact.handle },
        })
      )
      onOpenChange(false)
    },
    [onOpenChange]
  )

  const handleRemoveContact = React.useCallback(
    async (contact: Contact) => {
      const label = getContactDisplayName(contact)
      const confirmed = window.confirm(`Remove ${label} from contacts?`)
      if (!confirmed) return
      await removeContact(contact.handle)
      setShowContactInfo(false)
    },
    [removeContact]
  )

  const handleBlockContact = React.useCallback(
    async (contact: Contact) => {
      const label = getContactDisplayName(contact)
      const confirmed = window.confirm(`Block ${label}?`)
      if (!confirmed) return
      await blockUser(contact.handle)
      setShowContactInfo(false)
    },
    [blockUser]
  )

  return (
    <>
      <RecipientInfoDialog
        contact={selectedContact}
        open={showContactInfo}
        onOpenChange={setShowContactInfo}
        onBlockUser={handleBlockContact}
        onRemoveContact={handleRemoveContact}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[640px] max-h-[80vh] grid-rows-[auto_auto_1fr] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-emerald-600" />
              Contacts
            </DialogTitle>
            <DialogDescription>
              Manage saved handles and quickly view identity details.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search contacts"
                  className="pl-9"
                />
              </div>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <span className="text-xs text-muted-foreground">Group by server</span>
                <Switch
                  checked={groupByServer}
                  onCheckedChange={setGroupByServer}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={newHandle}
                onChange={(event) => setNewHandle(event.target.value)}
                placeholder="user@server.com"
                className="flex-1 min-w-[220px]"
                onKeyDown={(event) => event.key === "Enter" && handleAddContact()}
                disabled={isAdding}
              />
              <Button variant="accept" onClick={handleAddContact} disabled={isAdding}>
                <Plus className="mr-2 h-4 w-4" />
                {isAdding ? "Adding..." : "Add Contact"}
              </Button>
            </div>
            {addError ? (
              <p className="text-xs text-destructive">{addError}</p>
            ) : null}
          </div>

          <Separator />

          <div className="relative min-h-0">
            <ScrollArea className="h-full w-full pr-12">
              {isLoading ? (
                <p className="text-sm text-muted-foreground px-1 py-4">
                  Loading contacts...
                </p>
              ) : sections.length === 0 ? (
                <p className="text-sm text-muted-foreground px-1 py-4">
                  No contacts yet.
                </p>
              ) : (
                <div className="space-y-6 py-1 pr-2">
                  {sections.map((section) => (
                    <div
                      key={section.id}
                      ref={(node) => {
                        sectionRefs.current.set(section.id, node)
                      }}
                    >
                      <div className="sticky top-0 z-10 bg-background/90 backdrop-blur px-1 py-1">
                        <span className="text-xs font-semibold uppercase text-muted-foreground">
                          {section.label}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {section.contacts.map((contact) => (
                          <div
                            key={contact.handle}
                            className="flex w-full items-center justify-between rounded-lg border p-3 text-left transition hover:border-foreground/30 hover:bg-muted/50"
                          >
                            <button
                              type="button"
                              onClick={() => handleSelectContact(contact)}
                              className="flex flex-1 items-center gap-3 text-left"
                            >
                              <Avatar className="h-9 w-9">
                                <AvatarImage 
                                  src={contact.avatar_filename 
                                    ? `${process.env.NEXT_PUBLIC_API_URL}/uploads/avatars/${contact.avatar_filename}` 
                                    : undefined
                                  } 
                                  alt={getContactDisplayName(contact)} 
                                />
                                <AvatarFallback>
                                  {getContactInitials(contact)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="space-y-0.5">
                                <div className="text-sm font-medium">
                                  {getContactDisplayName(contact)}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {contact.handle}
                                </div>
                              </div>
                            </button>
                            <div className="ml-3 flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleSendMessage(contact)}
                                title="Send message"
                              >
                                <MessageSquare className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleRemoveContact(contact)}
                                title="Remove from contacts"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleBlockContact(contact)}
                                title="Block user"
                              >
                                <Ban className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
            <div className="absolute right-2 top-0 bottom-0 flex flex-col items-center justify-center gap-0.5 rounded-full border border-border/60 bg-background/90 px-1 py-2 text-[9px] text-muted-foreground shadow-sm overflow-y-auto no-scrollbar">
              {ALPHABET.map((letter) => {
                const isActive = indexLookup.has(letter)
                return (
                  <button
                    key={letter}
                    type="button"
                    className={
                      isActive
                        ? "px-0.5 font-semibold leading-none text-foreground"
                        : "px-0.5 leading-none text-muted-foreground/40"
                    }
                    onClick={() => handleIndexClick(letter)}
                    disabled={!isActive}
                    title={letter}
                  >
                    {letter}
                  </button>
                )
              })}
              <button
                type="button"
                className={
                  indexLookup.has("#")
                    ? "px-0.5 font-semibold leading-none text-foreground"
                    : "px-0.5 leading-none text-muted-foreground/40"
                }
                onClick={() => handleIndexClick("#")}
                disabled={!indexLookup.has("#")}
                title="#"
              >
                #
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
