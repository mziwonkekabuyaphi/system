// app/onboarding/OnboardingForm.tsx
"use client"

import { useState, useTransition } from "react"
import { createTenantAction, joinTenantAction } from "./actions"

export function OnboardingForm() {
  const [mode, setMode] = useState<"create" | "join">("create")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = (action: (formData: FormData) => Promise<{ error?: string } | void>) =>
    (formData: FormData) => {
      setError(null)
      startTransition(async () => {
        const result = await action(formData)
        if (result?.error) setError(result.error)
      })
    }

  return (
    <div className="mt-8">
      <div className="flex gap-4 border-b border-stone-200">
        <button type="button" onClick={() => { setMode("create"); setError(null) }}
          className={mode === "create" ? "border-b-2 border-stone-900 pb-2 font-medium" : "pb-2 text-stone-500"}>
          Create a business
        </button>
        <button type="button" onClick={() => { setMode("join"); setError(null) }}
          className={mode === "join" ? "border-b-2 border-stone-900 pb-2 font-medium" : "pb-2 text-stone-500"}>
          Join with a code
        </button>
      </div>

      {mode === "create" ? (
        <form action={handleSubmit(createTenantAction)} className="mt-6 space-y-4">
          <div>
            <label htmlFor="businessName" className="block text-sm text-stone-700">Business name</label>
            <input id="businessName" name="businessName" type="text" required
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2" />
          </div>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <button type="submit" disabled={isPending} className="w-full rounded bg-stone-900 py-2 text-white">
            {isPending ? "Creating…" : "Create business"}
          </button>
        </form>
      ) : (
        <form action={handleSubmit(joinTenantAction)} className="mt-6 space-y-4">
          <div>
            <label htmlFor="inviteCode" className="block text-sm text-stone-700">Invite code</label>
            <input id="inviteCode" name="inviteCode" type="text" required
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2" />
          </div>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <button type="submit" disabled={isPending} className="w-full rounded bg-stone-900 py-2 text-white">
            {isPending ? "Joining…" : "Join business"}
          </button>
        </form>
      )}
    </div>
  )
}
