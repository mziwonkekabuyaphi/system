"use client"

// app/demo/SetupBits.tsx
//
// Small form controls shared by the setup demo panels. They reuse the look of the
// admin cards in adminDemo.module.css so everything matches the WhatsApp admin demo.
// Only <div>/<span>/<label>/<button> here on purpose: the landing page's global
// heading and paragraph styles must not leak into the demo windows.

import { useEffect, useId, useState } from "react"
import admin from "./adminDemo.module.css"
import s from "./setupDemo.module.css"
import { HEX, normaliseHex } from "./setupData"

/** A colour picker plus a hex box. Only valid colours reach `onChange`. */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const id = useId()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const valid = HEX.test(text.trim())

  return (
    <div className={admin.aField}>
      <label className={admin.aFieldLabel} htmlFor={id}>
        {label}
      </label>
      <span className={s.colorRow}>
        <input
          type="color"
          className={s.colorSwatch}
          aria-label={`${label}, colour picker`}
          value={normaliseHex(value) ?? "#000000"}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          id={id}
          className={admin.aInput}
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid}
          onChange={(e) => {
            setText(e.target.value)
            const hex = normaliseHex(e.target.value)
            if (hex) onChange(hex)
          }}
        />
      </span>
      {!valid && <span className={admin.aHint}>Use a hex colour like #1f3a68.</span>}
    </div>
  )
}

/** The on/off switch from the admin cards. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={admin.aSwitch} onClick={() => onChange(!checked)} />
  )
}

/** A text field with a label, in the admin look. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: (id: string) => React.ReactNode
}) {
  const id = useId()
  return (
    <div className={admin.aField}>
      <label className={admin.aFieldLabel} htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className={admin.aHint}>{hint}</span>}
    </div>
  )
}

/** Marks a control that is a Business-plan feature in the real product. */
export function PlanTag({ children = "Business plan" }: { children?: string }) {
  return <span className={s.planTag}>{children}</span>
}
