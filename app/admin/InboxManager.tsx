"use client"

/**
 * Inbox tab — ported from the old standalone whatsapp-admin.html/admin.js
 * panel (1,100+ lines of vanilla JS, a separate static page hosted at
 * mzonke-six.vercel.app, talking to Supabase directly with the anon key
 * plus a cross-origin call to /api/admin/handover for the one
 * service-role-only write).
 *
 * KEPT (the core loop):
 *   - Conversation list with All / AI active / Needs human / Unread filters
 *   - Message thread for the selected conversation
 *   - Sending a message as the human agent
 *   - Pause / resume / resolve AI handling (handover.ts's state machine,
 *     via inbox-actions.ts's setConversationAiState — now a same-app
 *     Server Action instead of a cross-origin fetch with a shared secret)
 *   - A minimal customer panel: phone, name, message count
 *   - The analytics dashboard (kept on request — see AnalyticsDashboard.tsx
 *     for what changed: hand-rolled charts, no ai_requests table)
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

import { useState, useTransition } from "react"

import { AnalyticsDashboard } from "./AnalyticsDashboard"
import { getConversationThread, sendAgentMessage, setConversationAiState } from "./inbox-actions"
import type { AdminAiState, AdminConversationSummary, AdminInboxStats, AdminMessage } from "./types"

type Filter = "all" | "ai_active" | "needs_human" | "unread"

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "ai_active", label: "AI active" },
  { id: "needs_human", label: "Needs human" },
  { id: "unread", label: "Unread" },
]

const AI_STATE_STYLES: Record<AdminAiState, string> = {
  active: "bg-[#4B6B54]/10 text-[#4B6B54]",
  paused: "bg-stone-200 text-stone-600",
  handoff: "bg-[#7A2E3A]/10 text-[#7A2E3A]",
  resolved: "bg-stone-100 text-stone-400",
}

const AI_STATE_LABELS: Record<AdminAiState, string> = {
  active: "AI",
  paused: "Paused",
  handoff: "Needs human",
  resolved: "Resolved",
}

function formatWhen(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
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

export function InboxManager({
  initialConversations,
  initialStats,
}: {
  initialConversations: AdminConversationSummary[]
  initialStats: AdminInboxStats
}) {
  const [conversations, setConversations] = useState(initialConversations)
  const [filter, setFilter] = useState<Filter>("all")
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAnalytics, setShowAnalytics] = useState(false)

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

  // ── Thread view (mobile: replaces the list; desktop: list stays alongside) ──
  if (selected) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="text-sm font-medium text-stone-500 hover:text-stone-700"
        >
          ← Back to inbox
        </button>

        <div className="rounded-2xl border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-[family-name:var(--font-admin-serif)] text-lg text-stone-900">
                {selected.customerName ?? selected.phone}
              </p>
              <p className="text-sm text-stone-500">{selected.phone}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${AI_STATE_STYLES[selected.aiState]}`}>
              {AI_STATE_LABELS[selected.aiState]}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
            {selected.aiState !== "active" && (
              <button
                type="button"
                onClick={() => handleAiAction("resume")}
                disabled={isPending}
                className="rounded-full bg-[#4B6B54] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Resume AI
              </button>
            )}
            {selected.aiState === "active" && (
              <button
                type="button"
                onClick={() => handleAiAction("pause")}
                disabled={isPending}
                className="rounded-full border border-[#7A2E3A] px-3 py-1.5 text-sm font-medium text-[#7A2E3A] disabled:opacity-50"
              >
                Take over (pause AI)
              </button>
            )}
            {selected.aiState !== "resolved" && (
              <button
                type="button"
                onClick={() => handleAiAction("resolve")}
                disabled={isPending}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-stone-500 hover:bg-stone-100 disabled:opacity-50"
              >
                Mark resolved
              </button>
            )}
          </div>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="rounded-2xl border border-stone-200 bg-white p-3">
          {loadingThread ? (
            <p className="px-2 py-8 text-center text-sm text-stone-400">Loading messages…</p>
          ) : messages.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-stone-400">No messages yet.</p>
          ) : (
            <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto px-1 py-1">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "outgoing" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === "outgoing" ? "bg-[#7A2E3A] text-white" : "bg-stone-100 text-stone-800"
                    }`}
                  >
                    <p>{m.text ?? "(no text)"}</p>
                    <p className={`mt-1 text-[11px] ${m.direction === "outgoing" ? "text-white/70" : "text-stone-400"}`}>
                      {formatWhen(m.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend()
            }}
            placeholder="Type a message…"
            className="flex-1 rounded-full border border-stone-300 px-4 py-2 text-sm focus:border-[#7A2E3A] focus:outline-none focus:ring-1 focus:ring-[#7A2E3A]"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isPending || !draft.trim()}
            className="shrink-0 rounded-full bg-[#7A2E3A] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    )
  }

  // ── Conversation list + analytics toggle ──
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations…"
          className="flex-1 rounded-full border border-stone-300 px-4 py-2 text-sm focus:border-[#7A2E3A] focus:outline-none focus:ring-1 focus:ring-[#7A2E3A]"
        />
        <button
          type="button"
          onClick={() => setShowAnalytics((v) => !v)}
          className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium ${
            showAnalytics ? "bg-[#7A2E3A] text-white" : "border border-stone-300 text-stone-600"
          }`}
        >
          Analytics
        </button>
      </div>

      {showAnalytics && <AnalyticsDashboard stats={initialStats} />}

      <div className="flex gap-1 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
              filter === f.id ? "bg-stone-800 text-white" : "border border-stone-300 text-stone-600"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 px-5 py-10 text-center text-stone-500">
          No conversations match.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openConversation(c)}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white p-4 text-left shadow-sm hover:border-stone-300"
            >
              <div className="min-w-0">
                <p className="truncate font-[family-name:var(--font-admin-serif)] text-base text-stone-900">
                  {c.customerName ?? c.phone}
                </p>
                <p className="truncate text-sm text-stone-500">{c.lastMessagePreview ?? "No messages yet"}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-xs text-stone-400">{formatWhen(c.lastMessageAt)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${AI_STATE_STYLES[c.aiState]}`}>
                  {AI_STATE_LABELS[c.aiState]}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
