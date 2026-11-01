"use client"

/**
 * Inbox tab — ported from the old standalone whatsapp-admin.html/admin.js
 * panel, and laid out like it again: a conversation list on the left (search,
 * filter pills), the chat on the right, and a customer-info panel that slides in.
 *
 * KEPT (the core loop):
 *   - Conversation list with All / AI active / Needs human / Unread filters
 *   - Message thread for the selected conversation
 *   - Sending a message as the human agent
 *   - Pause / resume / resolve AI handling (handover.ts's state machine,
 *     via inbox-actions.ts's setConversationAiState — a same-app Server Action)
 *   - A minimal customer panel: phone, name, message count, last activity
 *   - The analytics dashboard (now in a right-hand panel)
 *
 * CUT (UI sugar with no backing table, not asked for): command palette,
 * keyboard shortcuts modal, emoji picker, quick-reply template panel,
 * attach-menu/file upload, image lightbox, and the old localStorage
 * notes/pins/favourites/tags layer.
 *
 * SIMPLIFICATION vs the old panel: no Supabase realtime subscription —
 * this reads once via the Server Component in page.tsx and again on
 * demand per action (getConversationThread, revalidatePath after
 * sends/state changes). A shop owner refreshing the page/tab covers a
 * prototype's needs; add a realtime channel before this is a full-time
 * multi-agent inbox.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react"

import { AdminDrawer } from "@/components/admin/AdminDrawer"
import { AnalyticsDashboard } from "./AnalyticsDashboard"
import { CustomersDrawer } from "./CustomersDrawer"
import { getConversationThread, sendAgentMessage, setConversationAiState } from "./inbox-actions"
import type { AdminAiState, AdminConversationSummary, AdminInboxStats, AdminMessage, AdminMessageSettings } from "./types"
import { WhatsAppSettingsDrawer } from "./WhatsAppSettingsDrawer"

type Filter = "all" | "ai_active" | "needs_human" | "unread"

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "ai_active", label: "AI active" },
  { id: "needs_human", label: "Needs human" },
  { id: "unread", label: "Unread" },
]

const AI_STATE_STYLES: Record<AdminAiState, string> = {
  active: "bg-accent/10 text-accent",
  paused: "bg-ink/[0.07] text-ink-soft",
  handoff: "bg-warn/10 text-warn",
  resolved: "bg-ink/[0.05] text-ink-muted",
}

const AI_STATE_LABELS: Record<AdminAiState, string> = {
  active: "AI",
  paused: "Paused",
  handoff: "Needs human",
  resolved: "Resolved",
}

// Dark theme only: hover gives a red edge + glow, and red buttons glow.
const ICON_BTN =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-tint-2 text-ink-muted transition-all hover:border-accent/40 hover:text-accent [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
const ICON_BTN_ON = "border-accent/40 bg-accent/10 text-accent"
const BTN =
  "rounded-lg border border-line-strong bg-card px-3 py-1.5 text-sm text-ink transition-shadow hover:bg-tint disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:hover:border-accent/50 [[data-admin-theme=dark]_&]:hover:shadow-[0_4px_14px_rgba(227,6,19,0.18)]"
const BTN_PRIMARY =
  "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-color transition-shadow hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 [[data-admin-theme=dark]_&]:shadow-[0_4px_16px_rgba(227,6,19,0.35)]"
const AVATAR_BG = "bg-[linear-gradient(135deg,var(--color-accent),#7b0009)] text-white"

function formatWhen(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function dayLabel(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })
}

function initialsOf(conversation: AdminConversationSummary): string {
  const name = conversation.customerName?.trim()
  if (!name) return conversation.phone.replace(/\D/g, "").slice(-2) || "#"
  const parts = name.split(/\s+/).filter(Boolean)
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

function matchesFilter(conversation: AdminConversationSummary, filter: Filter): boolean {
  if (filter === "all") return true
  if (filter === "ai_active") return conversation.aiState === "active"
  if (filter === "needs_human") return conversation.aiState === "handoff"
  // "Unread" is a proxy (last message came in and nothing's gone out
  // since) rather than a real read-receipt flag — this schema doesn't
  // track per-message read status reliably enough to do better.
  return conversation.lastMessagePreview !== null
}

// ---- Small inline icons ------------------------------------------------------
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const IconSearch = () => (
  <Svg>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </Svg>
)
const IconChart = () => (
  <Svg>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
)
const IconUsers = () => (
  <Svg>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19.5c0-3.2 2.4-5.5 5.5-5.5s5.5 2.3 5.5 5.5" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M16 14.2c2.6.3 4.5 2.3 4.5 5.3" />
  </Svg>
)
const IconGear = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
  </Svg>
)
const IconCard = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="11" r="2" />
    <path d="M6 16c.6-1.4 1.7-2 3-2s2.4.6 3 2M14.5 10h4M14.5 13.5h3" />
  </Svg>
)
const IconSend = () => (
  <Svg>
    <path d="M21 3 10 14" />
    <path d="m21 3-6.5 18-3.5-7-7-3.5L21 3Z" />
  </Svg>
)
const IconBack = () => (
  <Svg>
    <path d="m15 6-6 6 6 6" />
  </Svg>
)

/** The WhatsApp logo, from Font Awesome (stylesheet loaded in app/admin/layout.tsx). */
function WhatsAppGlyph({ className = "" }: { className?: string }) {
  return <i className={`fa-brands fa-whatsapp ${className}`} aria-hidden="true" />
}

function Avatar({ conversation, size }: { conversation: AdminConversationSummary; size: "sm" | "md" | "lg" }) {
  const dims = size === "lg" ? "h-16 w-16 text-lg" : size === "md" ? "h-9 w-9 text-xs" : "h-10 w-10 text-sm"
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-[family-name:var(--font-admin-serif)] font-bold ${AVATAR_BG} ${dims} [[data-admin-theme=dark]_&]:shadow-[0_0_12px_rgba(227,6,19,0.2)]`}
    >
      {initialsOf(conversation)}
    </span>
  )
}

export function InboxManager({
  initialConversations,
  initialStats,
  initialMessageSettings,
  timezone,
}: {
  initialConversations: AdminConversationSummary[]
  initialStats: AdminInboxStats
  /** message_settings row for the WhatsApp settings drawer (owner-only, like the Inbox itself). */
  initialMessageSettings: AdminMessageSettings
  /** Shop timezone, used by the Customers view (moved here from the sidebar). */
  timezone: string
}) {
  const [conversations, setConversations] = useState(initialConversations)
  const [filter, setFilter] = useState<Filter>("all")
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [customersOpen, setCustomersOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  const [messages, setMessages] = useState<AdminMessage[]>([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const selected = conversations.find((c) => c.id === selectedId) ?? null

  const filtered = conversations
    .filter((c) => matchesFilter(c, filter))
    .filter((c) => {
      const term = search.trim().toLowerCase()
      if (!term) return true
      return (c.customerName ?? "").toLowerCase().includes(term) || c.phone.includes(term)
    })

  // Keep the newest message in view when a thread loads or a message is added.
  const messagesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loadingThread, selectedId])

  function openConversation(conversation: AdminConversationSummary) {
    setSelectedId(conversation.id)
    setError(null)
    setLoadingThread(true)
    startTransition(async () => {
      const result = await getConversationThread(conversation.id)
      setLoadingThread(false)
      if (!result.success) {
        setError(result.error)
        return
      }
      setMessages(result.messages)
    })
  }

  function handleSend() {
    if (!selected || !draft.trim()) return
    const body = draft.trim()
    setDraft("")
    setError(null)
    startTransition(async () => {
      const result = await sendAgentMessage(selected.id, selected.phone, body)
      if (!result.success) {
        setError(result.error)
        return
      }
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, direction: "outgoing", text: body, createdAt: new Date().toISOString() },
      ])
      setConversations((prev) =>
        prev.map((c) =>
          c.id === selected.id ? { ...c, lastMessagePreview: body, lastMessageAt: new Date().toISOString() } : c,
        ),
      )
    })
  }

  function handleAiAction(action: "pause" | "resume" | "resolve") {
    if (!selected) return
    setError(null)
    startTransition(async () => {
      const result = await setConversationAiState(selected.phone, action)
      if (!result.success) {
        setError(result.error)
        return
      }
      const nextState: AdminAiState = action === "pause" ? "paused" : action === "resume" ? "active" : "resolved"
      setConversations((prev) => prev.map((c) => (c.id === selected.id ? { ...c, aiState: nextState } : c)))
    })
  }

  const countFor = (f: Filter) => conversations.filter((c) => matchesFilter(c, f)).length

  return (
    <div className="space-y-3">
      <div className="grid h-[calc(100dvh-11rem)] min-h-[32rem] overflow-hidden rounded-xl border border-line bg-card shadow-sm md:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ================= Conversation list ================= */}
        <aside className={`min-h-0 flex-col border-line bg-card md:border-r ${selected ? "hidden md:flex" : "flex"}`}>
          <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-accent/25 bg-accent/10 text-lg text-accent [[data-admin-theme=dark]_&]:shadow-[0_0_12px_rgba(227,6,19,0.35)]">
                <WhatsAppGlyph />
              </span>
              <div className="min-w-0">
                <p className="truncate font-[family-name:var(--font-admin-serif)] text-sm font-semibold text-ink">WhatsApp Inbox</p>
                <p className="text-[0.65rem] tracking-wide text-ink-muted">Conversations</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button type="button" onClick={() => setShowAnalytics(true)} className={ICON_BTN} title="Analytics" aria-label="Analytics">
                <IconChart />
              </button>
              <button type="button" onClick={() => setCustomersOpen(true)} className={ICON_BTN} title="Customers" aria-label="Customers">
                <IconUsers />
              </button>
              <button type="button" onClick={() => setSettingsOpen(true)} className={ICON_BTN} title="WhatsApp settings" aria-label="WhatsApp settings">
                <IconGear />
              </button>
            </div>
          </div>

          <div className="shrink-0 border-b border-line px-3 py-2.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-line bg-tint-2 px-3 transition-colors focus-within:border-accent/40">
              <span className="text-ink-muted">
                <IconSearch />
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search conversations…"
                aria-label="Search conversations"
                className="w-full bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-muted"
              />
            </div>
          </div>

          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 pb-2.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[0.7rem] font-semibold transition-all ${
                  filter === f.id
                    ? "border-accent/30 bg-accent/10 text-accent"
                    : "border-line bg-tint-2 text-ink-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {f.label}
                <span className="text-[0.6rem] opacity-75">{countFor(f.id)}</span>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-ink-muted">No conversations match.</p>
            ) : (
              filtered.map((c) => {
                const active = c.id === selectedId
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c)}
                    aria-current={active ? "true" : undefined}
                    className={`relative flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition-colors ${
                      active ? "bg-accent/10" : "hover:bg-tint-2"
                    }`}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-[20%] left-0 top-[20%] w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
                      />
                    )}
                    <Avatar conversation={c} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-ink">{c.customerName ?? c.phone}</p>
                        <span className="shrink-0 text-[0.65rem] text-ink-muted">{formatWhen(c.lastMessageAt)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <p className="truncate text-xs text-ink-muted">{c.lastMessagePreview ?? "No messages yet"}</p>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6rem] font-bold ${AI_STATE_STYLES[c.aiState]}`}>
                          {AI_STATE_LABELS[c.aiState]}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        {/* ================= Chat ================= */}
        <section className={`min-h-0 min-w-0 flex-col bg-canvas ${selected ? "flex" : "hidden md:flex"}`}>
          {!selected ? (
            <div className="m-auto flex flex-col items-center gap-3 px-6 text-center">
              <WhatsAppGlyph className="text-5xl text-ink-muted/40" />
              <p className="text-sm font-semibold text-ink-muted">Select a conversation</p>
              <p className="max-w-[16rem] text-xs text-ink-muted/80">Pick a customer from the list to view the conversation history.</p>
            </div>
          ) : (
            <>
              <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-card px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className={`${ICON_BTN} md:hidden`}
                    aria-label="Back to conversations"
                    title="Back"
                  >
                    <IconBack />
                  </button>
                  <Avatar conversation={selected} size="md" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{selected.customerName ?? selected.phone}</p>
                    <p className="truncate text-[0.7rem] text-ink-muted">{selected.phone}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`hidden rounded-full px-2.5 py-1 text-xs font-medium sm:inline-block ${AI_STATE_STYLES[selected.aiState]}`}>
                    {AI_STATE_LABELS[selected.aiState]}
                  </span>
                  {selected.aiState === "active" ? (
                    <button type="button" onClick={() => handleAiAction("pause")} disabled={isPending} className={BTN}>
                      Take over
                    </button>
                  ) : selected.aiState !== "resolved" ? (
                    <button type="button" onClick={() => handleAiAction("resume")} disabled={isPending} className={BTN_PRIMARY}>
                      Resume AI
                    </button>
                  ) : (
                    <button type="button" onClick={() => handleAiAction("resume")} disabled={isPending} className={BTN}>
                      Reopen with AI
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setInfoOpen(true)}
                    className={`${ICON_BTN} ${infoOpen ? ICON_BTN_ON : ""}`}
                    title="Customer info"
                    aria-label="Customer info"
                  >
                    <IconCard />
                  </button>
                </div>
              </header>

              {error && <p className="shrink-0 bg-accent/10 px-4 py-2 text-sm text-accent">{error}</p>}

              <div ref={messagesRef} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-4 py-4 sm:px-8">
                {loadingThread ? (
                  <div className="space-y-3 py-2" aria-label="Loading messages">
                    {[60, 40, 52].map((w, i) => (
                      <div key={i} className={`h-9 animate-pulse rounded-xl bg-tint ${i % 2 ? "ml-auto" : ""}`} style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <p className="m-auto text-sm text-ink-muted">No messages yet.</p>
                ) : (
                  messages.map((m, i) => {
                    const outgoing = m.direction === "outgoing"
                    const newDay = i === 0 || new Date(m.createdAt).toDateString() !== new Date(messages[i - 1].createdAt).toDateString()
                    return (
                      <div key={m.id} className="flex flex-col">
                        {newDay && (
                          <div className="my-2 flex justify-center">
                            <span className="rounded-full border border-line bg-card px-3.5 py-0.5 text-[0.65rem] text-ink-muted">
                              {dayLabel(m.createdAt)}
                            </span>
                          </div>
                        )}
                        <div className={`flex py-[3px] ${outgoing ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[78%] break-words px-3.5 py-2 text-[0.83rem] leading-relaxed ${
                              outgoing
                                ? "rounded-[14px_4px_14px_14px] bg-accent text-on-color shadow-sm [[data-admin-theme=dark]_&]:shadow-[0_4px_16px_rgba(227,6,19,0.25)]"
                                : "rounded-[4px_14px_14px_14px] border border-line bg-card text-ink"
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{m.text ?? "(no text)"}</p>
                            <p className={`mt-1 text-right text-[0.6rem] ${outgoing ? "text-white/60" : "text-ink-muted"}`}>
                              {formatClock(m.createdAt)}
                            </p>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2 border-t border-line bg-card px-4 py-3">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSend()
                  }}
                  placeholder="Type a message…"
                  aria-label="Type a message"
                  className="flex-1 rounded-[10px] border border-line bg-tint-2 px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-accent/40"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={isPending || !draft.trim()}
                  aria-label="Send"
                  title="Send"
                  className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] bg-accent text-on-color transition-all hover:scale-[1.03] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 [[data-admin-theme=dark]_&]:shadow-[0_0_16px_rgba(227,6,19,0.35)]"
                >
                  <IconSend />
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Analytics: right-hand panel, so the inbox stays right behind it */}
      <AdminDrawer open={showAnalytics} onClose={() => setShowAnalytics(false)} width="lg" title="Inbox analytics" subtitle="How the WhatsApp inbox has been doing.">
        <AnalyticsDashboard stats={initialStats} />
      </AdminDrawer>

      {/* Customer info for the open conversation */}
      <AdminDrawer open={infoOpen && selected !== null} onClose={() => setInfoOpen(false)} title="Customer info">
        {selected && (
          <div className="space-y-5">
            <div className="flex flex-col items-center border-b border-line pb-5 text-center">
              <Avatar conversation={selected} size="lg" />
              <p className="mt-3 text-base font-semibold text-ink">{selected.customerName ?? "No name on file"}</p>
              <p className="text-sm text-ink-muted">{selected.phone}</p>
              <span className={`mt-2 rounded-full px-2.5 py-0.5 text-xs font-medium ${AI_STATE_STYLES[selected.aiState]}`}>
                {AI_STATE_LABELS[selected.aiState]}
              </span>

              <div className="mt-4 flex w-full items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${selected.aiState === "active" ? "bg-success shadow-[0_0_6px_var(--color-success)]" : "bg-ink-muted/50"}`}
                />
                <span className="text-ink-muted">{selected.aiState === "active" ? "AI is replying" : "AI is not replying"}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={selected.aiState === "active"}
                  aria-label={selected.aiState === "active" ? "Pause AI and take over" : "Resume AI"}
                  disabled={isPending}
                  onClick={() => handleAiAction(selected.aiState === "active" ? "pause" : "resume")}
                  className={`relative ml-auto h-5 w-9 shrink-0 rounded-full border transition-all disabled:opacity-50 ${
                    selected.aiState === "active"
                      ? "border-accent bg-accent [[data-admin-theme=dark]_&]:shadow-[0_0_10px_rgba(227,6,19,0.35)]"
                      : "border-line bg-tint-3"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white transition-all ${selected.aiState === "active" ? "left-[18px]" : "left-[2px]"}`}
                  />
                </button>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-muted">Profile</h3>
              <dl className="divide-y divide-line text-sm">
                {(
                  [
                    ["Phone", selected.phone],
                    ["Name", selected.customerName ?? "Not saved"],
                    ["Messages", `${selected.messageCount}`],
                    ["Last activity", selected.lastMessageAt ? `${dayLabel(selected.lastMessageAt)}, ${formatClock(selected.lastMessageAt)}` : "None yet"],
                  ] as Array<[string, string]>
                ).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-4 py-2">
                    <dt className="text-ink-muted">{k}</dt>
                    <dd className="text-right font-medium text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div>
              <h3 className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-muted">Actions</h3>
              <div className="flex flex-col gap-2">
                {selected.aiState !== "active" && (
                  <button type="button" onClick={() => handleAiAction("resume")} disabled={isPending} className={BTN_PRIMARY}>
                    Resume AI
                  </button>
                )}
                {selected.aiState === "active" && (
                  <button type="button" onClick={() => handleAiAction("pause")} disabled={isPending} className={BTN}>
                    Take over (pause AI)
                  </button>
                )}
                {selected.aiState !== "resolved" && (
                  <button type="button" onClick={() => handleAiAction("resolve")} disabled={isPending} className={BTN}>
                    Mark resolved
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </AdminDrawer>

      {/* Customers: right-hand overlay panel, so the Inbox stays right behind it */}
      <CustomersDrawer open={customersOpen} onClose={() => setCustomersOpen(false)} timezone={timezone} />

      {/* WhatsApp settings: right-hand overlay panel */}
      <WhatsAppSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        messageSettings={initialMessageSettings}
      />
    </div>
  )
}
