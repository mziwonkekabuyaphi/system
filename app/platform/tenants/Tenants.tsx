// app/platform/tenants/Tenants.tsx
"use client"

import { useState, useTransition } from "react"

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
    <main className="mx-auto max-w-6xl space-y-5 px-6 py-10">
      <h1 className="font-[family-name:var(--font-admin-serif)] text-3xl tracking-tight text-stone-900">Shops ({rows.length})</h1>
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
                <td>{r.status}</td>
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
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
      <p className="mb-2 text-sm font-semibold text-stone-800">Waiting for approval ({pending.length})</p>
      <div className="divide-y divide-amber-200">
        {pending.map((p) => {
          const chosen = current(p)
          return (
            <div key={p.id} className="space-y-2 py-3 text-sm">
              <div>
                <span className="font-medium text-stone-900">{p.name}</span>{" "}
                <span className="font-mono text-xs text-stone-500">{p.slug}</span>
                <span className="ml-2 text-xs text-stone-500">signed up {date(p.createdAt)}</span>
              </div>
              <div className="text-xs text-stone-600">
                {p.ownerName ?? "Owner"} · {p.ownerEmail ?? "no email"} · asked for: {p.requested.length ? p.requested.join(", ") : "nothing specific"}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-stone-700">
                <span className="text-xs uppercase text-stone-400">Switch on</span>
                {CREATABLE_MODULES.map((m) => (
                  <label key={m.key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={chosen.includes(m.key)}
                      onChange={(e) =>
                        setPicked((cur) => ({ ...cur, [p.id]: e.target.checked ? [...chosen, m.key] : chosen.filter((k) => k !== m.key) }))
                      }
                    />
                    {m.label}
                  </label>
                ))}
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
    </div>
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
    <div className={card}>
      <p className="mb-2 text-sm font-semibold text-stone-800">Create a shop</p>
      <div className="flex flex-wrap gap-2">
        <input className={input} placeholder="Business name" value={name} onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugify(e.target.value)) }} />
        <input className={input} placeholder="web-address" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugEdited(true) }} />
        <input className={input} type="email" placeholder="Owner email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-700">
          <span className="text-xs uppercase text-stone-400">Switched on from day one</span>
          {CREATABLE_MODULES.map((m) => (
            <label key={m.key} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={modules.includes(m.key)}
                onChange={(e) => setModules((cur) => (e.target.checked ? [...cur, m.key] : cur.filter((k) => k !== m.key)))}
              />
              {m.label}
            </label>
          ))}
        </div>
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
      </div>
      <p className="mt-2 text-xs text-stone-500">
        You get an owner invite code. If you enter the owner&apos;s email, only that email can use the code.
      </p>
    </div>
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
