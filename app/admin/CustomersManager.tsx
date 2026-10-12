// app/admin/CustomersManager.tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { loadCustomers, type AdminCustomer } from "./actions"

type SortKey = "name" | "bookings" | "latest"

const PAGE_SIZE = 50

function displayName(c: AdminCustomer): string {
  return c.name?.trim() || c.phone || "Unknown customer"
}

function initialOf(c: AdminCustomer): string {
  const name = c.name?.trim()
  return name ? name.charAt(0).toUpperCase() : "#"
}

export function CustomersManager({ timezone }: { timezone: string }) {
  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortKey>("name")
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadCustomers().then((result) => {
      if (cancelled) return
      if (result.ok) setCustomers(result.customers)
      else setError(result.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const filtered = useMemo(() => {
    if (!customers) return []
    const q = query.trim().toLowerCase()
    const qDigits = q.replace(/\D/g, "")

    const matches = q
      ? customers.filter((c) => {
          if ((c.name ?? "").toLowerCase().includes(q)) return true
          if ((c.email ?? "").toLowerCase().includes(q)) return true
          if (c.phone.toLowerCase().includes(q)) return true
          // "082 123" should still find "0821234567"
          return qDigits.length >= 3 && c.phone.replace(/\D/g, "").includes(qDigits)
        })
      : customers

    const sorted = [...matches]
    if (sort === "name") {
      sorted.sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }))
    } else if (sort === "bookings") {
      sorted.sort((a, b) => b.bookingCount + b.queueCount - (a.bookingCount + a.queueCount))
    } else {
      sorted.sort((a, b) => (b.latestBookingAt ?? "").localeCompare(a.latestBookingAt ?? ""))
    }
    return sorted
  }, [customers, query, sort])

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-ZA", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  }

  if (loading && !customers) {
    return <p className="text-sm text-[#8A8375]">Loading your customers…</p>
  }

  if (error && !customers) {
    return (
      <div>
        <p className="text-sm text-[#7A2E2E]">{error}</p>
        <button onClick={() => setReloadKey((k) => k + 1)} className="mt-3 text-sm text-[#1C1A17] underline underline-offset-4">
          Try again
        </button>
      </div>
    )
  }

  const total = customers?.length ?? 0

  if (total === 0) {
    return (
      <p className="text-[#8A8375]">
        No customers yet. They appear here automatically when someone books or joins your queue.
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[12rem] flex-1">
          <label className="block text-sm text-[#8A8375]">Search</label>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setVisible(PAGE_SIZE)
            }}
            placeholder="Name, phone or email"
            className="mt-1 w-full border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          />
        </div>
        <div>
          <label className="block text-sm text-[#8A8375]">Sort by</label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="mt-1 border-b border-[#D9D3C3] bg-transparent pb-1 text-[#1C1A17] outline-none focus:border-[#7A2E2E]"
          >
            <option value="name">Name (A–Z)</option>
            <option value="bookings">Most visits</option>
            <option value="latest">Latest booking</option>
          </select>
        </div>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          className="pb-1 text-sm text-[#8A8375] disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <p className="mt-4 text-sm text-[#8A8375]">
        {query.trim()
          ? `${filtered.length} of ${total} customers`
          : `${total} ${total === 1 ? "customer" : "customers"}`}
      </p>

      {filtered.length === 0 ? (
        <p className="mt-6 text-[#8A8375]">No customers match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="mt-2 divide-y divide-[#E6E1D4]">
          {filtered.slice(0, visible).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#E6E1D4] text-sm font-medium text-[#1C1A17]">
                  {initialOf(c)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[1.05rem] text-[#1C1A17]">{displayName(c)}</p>
                  <p className="truncate text-sm text-[#8A8375]">
                    {[c.name?.trim() ? c.phone : null, c.email].filter(Boolean).join(" · ") || "No contact details"}
                  </p>
                </div>
              </div>
              <div className="shrink-0 text-right text-sm">
                <p className="text-[#1C1A17]">
                  {c.bookingCount} {c.bookingCount === 1 ? "booking" : "bookings"}
                  {c.queueCount > 0 && (
                    <span className="text-[#8A8375]">
                      {" "}
                      · {c.queueCount} walk-in{c.queueCount === 1 ? "" : "s"}
                    </span>
                  )}
                </p>
                {c.latestBookingAt && (
                  <p className="mt-0.5 text-xs text-[#8A8375]">Latest: {formatDate(c.latestBookingAt)}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {filtered.length > visible && (
        <button
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="mt-4 text-sm text-[#1C1A17] underline underline-offset-4"
        >
          Show more ({filtered.length - visible} left)
        </button>
      )}
    </div>
  )
}
