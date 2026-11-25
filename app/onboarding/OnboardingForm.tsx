// app/onboarding/OnboardingForm.tsx
"use client"

import { useMemo, useState, useTransition } from "react"
import { createTenantAction, joinTenantAction } from "./actions"

export type PresetOption = {
  key: string
  name: string
  emoji: string | null
  description: string | null
  modules: string[]
}
export type ModuleOption = { key: string; name: string; description: string | null; self_serve?: boolean }

type Props = {
  presets: PresetOption[]
  modules: ModuleOption[]
  /** module key -> groups; a group is satisfied when ANY key in it is switched on. */
  requires: Record<string, string[][]>
  /** Modules a new business gets immediately; everything else needs our approval. */
  selfServe: string[]
}

export function OnboardingForm({ presets, modules, requires, selfServe }: Props) {
  const [mode, setMode] = useState<"create" | "join">("create")
  const [step, setStep] = useState<1 | 2>(1)
  const [businessName, setBusinessName] = useState("")
  const [industry, setIndustry] = useState<string>("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const preset = presets.find((p) => p.key === industry)
  const moduleName = useMemo(() => Object.fromEntries(modules.map((m) => [m.key, m.name])), [modules])

  const handleSubmit =
    (action: (formData: FormData) => Promise<{ error?: string } | void>) => (formData: FormData) => {
      setError(null)
      startTransition(async () => {
        const result = await action(formData)
        if (result?.error) setError(result.error)
      })
    }

  // A module is unavailable until one key from every requirement group is on.
  const firstUnmetGroup = (key: string, on: Set<string>) =>
    (requires[key] ?? []).find((group) => !group.some((k) => on.has(k)))

  function pickIndustry(key: string) {
    setIndustry(key)
    setSelected(new Set(presets.find((p) => p.key === key)?.modules ?? []))
  }

  function toggleModule(key: string) {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    // Switching something off can orphan modules that depended on it.
    let changed = true
    while (changed) {
      changed = false
      for (const k of Array.from(next)) {
        if (firstUnmetGroup(k, next)) {
          next.delete(k)
          changed = true
        }
      }
    }
    setSelected(next)
  }

  function goToModules() {
    if (!businessName.trim()) return setError("Enter a business name.")
    if (!industry) return setError("Choose the type of business you run.")
    setError(null)
    setStep(2)
  }

  const waiting = Array.from(selected).filter((k) => !selfServe.includes(k)).map((k) => moduleName[k] ?? k)
  const readyNow = Array.from(selected).filter((k) => selfServe.includes(k)).map((k) => moduleName[k] ?? k)
  const approvalNote =
    waiting.length === 0
      ? "Everything you picked is ready as soon as you create your business."
      : readyNow.length > 0
        ? `${readyNow.join(" and ")} ${readyNow.length > 1 ? "are" : "is"} ready straight away. ${waiting.join(", ")} will be switched on once we've approved ${waiting.length > 1 ? "them" : "it"}.`
        : `We approve ${waiting.join(", ")} before ${waiting.length > 1 ? "they go" : "it goes"} live, so we'll review your business first.`

  const recommended = modules.filter((m) => preset?.modules.includes(m.key))
  const others = modules.filter((m) => !preset?.modules.includes(m.key))

  const tab = (active: boolean) =>
    active ? "border-b-2 border-stone-900 pb-2 font-medium" : "pb-2 text-stone-500"

  function renderModule(m: ModuleOption) {
    const on = selected.has(m.key)
    const unmet = !on ? firstUnmetGroup(m.key, selected) : undefined
    return (
      <label
        key={m.key}
        className={`flex items-start gap-3 rounded border px-3 py-2 text-sm ${
          unmet ? "border-stone-200 text-stone-400" : "border-stone-300 text-stone-800"
        }`}
      >
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={!!unmet}
          onChange={() => toggleModule(m.key)}
        />
        <span>
          <span className="block font-medium">{m.name}</span>
          {m.description && <span className="block text-xs text-stone-500">{m.description}</span>}
          {unmet && (
            <span className="block text-xs text-stone-500">
              Needs {unmet.map((k) => moduleName[k] ?? k).join(" or ")} first.
            </span>
          )}
        </span>
      </label>
    )
  }

  return (
    <div className="mt-8">
      <div className="flex gap-4 border-b border-stone-200">
        <button type="button" onClick={() => { setMode("create"); setError(null) }} className={tab(mode === "create")}>
          Create a business
        </button>
        <button type="button" onClick={() => { setMode("join"); setError(null) }} className={tab(mode === "join")}>
          Join with a code
        </button>
      </div>

      {mode === "create" && presets.length === 0 && (
        <p className="mt-6 text-sm text-red-600" role="alert">
          Business types couldn&apos;t be loaded. Please refresh, or contact support if this keeps happening.
        </p>
      )}

      {mode === "create" && presets.length > 0 && step === 1 && (
        <div className="mt-6 space-y-6">
          <div>
            <label htmlFor="businessName" className="block text-sm text-stone-700">Business name</label>
            <input
              id="businessName"
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); goToModules() } }}
              className="mt-1 w-full rounded border border-stone-300 px-3 py-2"
            />
          </div>

          <fieldset>
            <legend className="block text-sm text-stone-700">What kind of business is it?</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {presets.map((p) => (
                <label
                  key={p.key}
                  className={`cursor-pointer rounded border px-3 py-3 text-sm ${
                    industry === p.key ? "border-stone-900 bg-stone-50" : "border-stone-300 hover:border-stone-400"
                  }`}
                >
                  <input
                    type="radio"
                    name="industry-choice"
                    value={p.key}
                    checked={industry === p.key}
                    onChange={() => pickIndustry(p.key)}
                    className="sr-only"
                  />
                  <span className="block text-lg" aria-hidden="true">{p.emoji}</span>
                  <span className="block font-medium text-stone-900">{p.name}</span>
                </label>
              ))}
            </div>
            {preset?.description && <p className="mt-2 text-xs text-stone-500">{preset.description}</p>}
          </fieldset>

          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <button type="button" onClick={goToModules} className="w-full rounded bg-stone-900 py-2 text-white">
            Continue
          </button>
        </div>
      )}

      {mode === "create" && presets.length > 0 && step === 2 && (
        <form action={handleSubmit(createTenantAction)} className="mt-6 space-y-6">
          <input type="hidden" name="businessName" value={businessName} />
          <input type="hidden" name="industry" value={industry} />
          {Array.from(selected).map((k) => (
            <input key={k} type="hidden" name="modules" value={k} />
          ))}

          <div>
            <h2 className="text-lg text-stone-900">What should we switch on for {businessName.trim()}?</h2>
            <p className="mt-1 text-sm text-stone-600">
              We&apos;ve ticked what most {preset?.name.toLowerCase()} businesses use and filled in sensible
              defaults for hours, bookings and queues. You can change all of it later.
            </p>
          </div>

          {recommended.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-stone-700">Recommended for {preset?.name.toLowerCase()}</p>
              {recommended.map(renderModule)}
            </div>
          )}
          {others.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-stone-700">Add more</p>
              {others.map(renderModule)}
            </div>
          )}

          {approvalNote && <p className="text-xs text-stone-500">{approvalNote}</p>}

          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setStep(1); setError(null) }}
              className="rounded border border-stone-300 px-4 py-2 text-stone-700"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={isPending || selected.size === 0}
              className="flex-1 rounded bg-stone-900 py-2 text-white disabled:opacity-50"
            >
              {isPending ? "Setting up…" : "Create business"}
            </button>
          </div>
        </form>
      )}

      {mode === "join" && (
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
