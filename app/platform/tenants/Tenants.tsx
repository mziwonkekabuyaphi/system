// app/platform/tenants/Tenants.tsx
"use client"

import { useState, useTransition } from "react"

import { ModulePicker } from "@/components/platform/ModulePicker"
import { PageHeader } from "@/components/platform/PageHeader"
import { CREATABLE_MODULES, type NewShopModule } from "@/lib/services/new-shop-modules"
import { approveShop, createOwnerInvite, createShop, declineShop } from "./actions"

type Pending = { id: string; name: string; slug: string; createdAt: string | null; requested: string[]; ownerName: string | null; ownerEmail: string | null }
type Row ={ id: string; name: string; slug: string; status: string; createdAt: string | null; members: number; referredBy: string | null }

const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-ZA") : "—")
const card = "rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
const input = "rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
const btn = "rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
const btn2 = "rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 disabled:opacity-50"

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)

export function Tenants({ rows, pending }: { rows: Row[]; pending: Pending[] }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [invite, setInvite] = useState<{ shop: string; code: string } | null>(null)
  const [busy, start] = useTransition()
  const [query, setQuery] = useState("")

  const shown = rows.filter((r) => `${r.name} ${r.slug}`.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <main className="space-y-6">
      <PageHeader title="Shops" count={rows.length} description="Approve new shops, create one, or invite an owner." />
      {msg && <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
      {invite && <InviteBox shop={invite.shop} code={invite.code} onClose={() => setInvite(null)} />}

      {pending.length > 0 && <WaitingForApproval pending={pending} busy={busy} start={start} setMsg={setMsg} />}

      <NewShop busy={busy} start={start} setMsg={setMsg} setInvite={setInvite} />

      <div className={card}>
        <input className={`${input} mb-3 w-full sm:w-72`} placeholder="Search by name or web address" value={query} onChange={(e) => setQuery(e.target.value)} />
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-stone-400">
            <tr><th className="py-2">Shop</th><th>Web address</th><th>Status</th><th className="text-right">People</th><th>Referred by</th><th>Created</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="py-2 text-stone-900">{r.name}</td>
                <td className="font-mono text-xs">{r.slug}</td>
                <td>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${r.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : r.status === "pending" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-stone-100 text-stone-600 ring-stone-200"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="text-right tabular-nums">{r.members}</td>
                <td>{r.referredBy ?? "—"}</td>
                <td>{date(r.createdAt)}</td>
                <td className="text-right">
                  <button
                    className={btn2}
                    disabled={busy}
                    onClick={() => {
                      setMsg(null)
                      start(async () => {
                        const res = await createOwnerInvite({ tenantId: r.id, ownerEmail: "" })
                        if (res.success) setInvite({ shop: r.name, code: res.inviteCode })
                        else setMsg({ ok: false, text: res.error })
                      })
                    }}
                  >
                    Owner invite
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="py-3 text-sm text-stone-500">No shops found.</p>}
      </div>
    </main>
  )
}

type Msg = { ok: boolean; text: string } | null

/** Self-signed-up shops waiting for a decision. The ticks start at what the owner asked for; change them before approving. */
function WaitingForApproval({ pending, busy, start, setMsg }: {
  pending: Pending[]
  busy: boolean
  start: (fn: () => Promise<void>) => void
  setMsg: (m: Msg) => void
}) {
  const [picked, setPicked] = useState<Record<string, NewShopModule[]>>({})
  const current = (p: Pending): NewShopModule[] =>
    picked[p.id] ?? CREATABLE_MODULES.filter((m) => p.requested.includes(m.key)).map((m) => m.key)

  return (
    <section className="overflow-hidden rounded-2xl border border-amber-300 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-5 py-3">
        <h2 className="text-sm font-semibold text-stone-800">Waiting for approval</h2>
        <span className="rounded-full bg-amber-200 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-amber-900">{pending.length}</span>
      </div>
      <div className="divide-y divide-stone-100">
        {pending.map((p) => {
          const chosen = current(p)
          return (
            <div key={p.id} className="space-y-4 p-5 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-stone-900">{p.name}</h3>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">Pending</span>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-stone-500">/{p.slug}</p>
                </div>
                <p className="text-xs text-stone-500">Signed up {date(p.createdAt)}</p>
              </div>
              <p className="text-xs text-stone-600">
                {p.ownerName ?? "Owner"} · {p.ownerEmail ?? "no email"}
                {p.requested.length === 0 && " · didn't ask for anything specific"}
              </p>
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">Switch on when approved</p>
                <ModulePicker
                  value={chosen}
                  requested={p.requested}
                  disabled={busy}
                  onChange={(next) => setPicked((cur) => ({ ...cur, [p.id]: next }))}
                />
              </div>
              <div className="flex gap-2">
                <button
                  className={btn}
                  disabled={busy || chosen.length === 0}
                  onClick={() => {
                    setMsg(null)
                    start(async () => {
                      const res = await approveShop({ tenantId: p.id, modules: chosen })
                      setMsg(res.success ? { ok: true, text: `${p.name} approved and switched on.` } : { ok: false, text: res.error })
                    })
                  }}
                >
                  Approve
                </button>
                <button
                  className={btn2}
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Decline ${p.name}? The owner will see that it wasn't approved.`)) return
                    setMsg(null)
                    start(async () => {
                      const res = await declineShop({ tenantId: p.id })
                      setMsg(res.success ? { ok: true, text: `${p.name} declined.` } : { ok: false, text: res.error })
                    })
                  }}
                >
                  Decline
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NewShop({ busy, start, setMsg, setInvite }: {
  busy: boolean
  start: (fn: () => Promise<void>) => void
  setMsg: (m: Msg) => void
  setInvite: (i: { shop: string; code: string } | null) => void
}) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [email, setEmail] = useState("")
  const [modules, setModules] = useState<NewShopModule[]>(CREATABLE_MODULES.filter((m) => m.defaultOn).map((m) => m.key))

  return (
    <section className={`${card} space-y-4`}>
      <h2 className="text-sm font-semibold text-stone-800">Create a shop</h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={input} placeholder="Business name" value={name} onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugify(e.target.value)) }} />
        <input className={input} placeholder="web-address" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }} />
        <input className={input} type="email" placeholder="Owner email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">Switched on from day one</p>
        <ModulePicker value={modules} onChange={setModules} disabled={busy} />
      </div>
      <div>
        <button
          className={btn}
          disabled={busy}
          onClick={() => {
            setMsg(null)
            setInvite(null)
            start(async () => {
              const res = await createShop({ name, slug, ownerEmail: email, modules })
              if (res.success) {
                setMsg({ ok: true, text: `Shop created at /web/${res.slug}.` })
                setInvite({ shop: name, code: res.inviteCode })
                setName(""); setSlug(""); setSlugEdited(false); setEmail("")
              } else {
                setMsg({ ok: false, text: res.error })
              }
            })
          }}
        >
          Create shop
        </button>
        <p className="mt-2 text-xs text-stone-500">
          You get an owner invite code. If you enter the owner&apos;s email, only that email can use the code.
        </p>
      </div>
    </section>
  )
}

function InviteBox({ shop, code, onClose }: { shop: string; code: string; onClose: () => void }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-stone-800">
      <p className="font-medium">Owner invite for {shop}</p>
      <p className="mt-1 font-mono text-lg tracking-wider">{code}</p>
      <p className="mt-1 text-stone-600">
        Send the owner to <span className="font-mono">{typeof window !== "undefined" ? window.location.origin : ""}/signup</span> to make an account, then they choose
        &ldquo;Join with a code&rdquo; and enter this code. It can be used once and expires.
      </p>
      <button className="mt-2 text-xs underline" onClick={onClose}>Dismiss</button>
    </div>
  )
}
