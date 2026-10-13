// app/refer/[code]/ReferralForm.tsx
"use client"

import { useState, useTransition } from "react"

import { submitReferralSignup } from "./actions"

const field = "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"

export function ReferralForm({ code }: { code: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (done) {
    return (
      <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
        Thank you! We&apos;ve received your request and will contact you once your account is approved.
      </div>
    )
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const get = (k: string) => String(fd.get(k) ?? "")
    setError(null)
    start(async () => {
      const res = await submitReferralSignup({
        code,
        businessName: get("businessName"),
        contactName: get("contactName"),
        phone: get("phone"),
        email: get("email"),
        notes: get("notes"),
      })
      if (res.success) setDone(true)
      else setError(res.error)
    })
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-4">
      <label className="block text-sm font-medium text-stone-700">Business name
        <input name="businessName" required maxLength={120} className={field} />
      </label>
      <label className="block text-sm font-medium text-stone-700">Your name
        <input name="contactName" required maxLength={120} className={field} />
      </label>
      <label className="block text-sm font-medium text-stone-700">Phone
        <input name="phone" type="tel" required className={field} />
      </label>
      <label className="block text-sm font-medium text-stone-700">Email (optional)
        <input name="email" type="email" className={field} />
      </label>
      <label className="block text-sm font-medium text-stone-700">Anything we should know? (optional)
        <textarea name="notes" rows={3} maxLength={500} className={field} />
      </label>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={pending} className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Sending…" : "Request my account"}
      </button>
    </form>
  )
}
