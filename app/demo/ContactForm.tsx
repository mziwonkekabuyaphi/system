"use client"
// app/demo/ContactForm.tsx — "Book a demo / Ask a question" form for the landing page.

import { useState, useTransition } from "react"
import type { FormEvent } from "react"

import styles from "./demo.module.css"
import { submitContactRequest } from "./actions"

export function ContactForm({ email }: { email: string }) {
  const [kind, setKind] = useState<"demo" | "contact">("demo")
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, startTransition] = useTransition()

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const form = event.currentTarget
    const data = new FormData(form)
    data.set("kind", kind)
    startTransition(async () => {
      const result = await submitContactRequest(data)
      if (result.ok) {
        setSent(true)
        form.reset()
      } else {
        setError(result.error)
      }
    })
  }

  if (sent) {
    return (
      <div className={styles.contactCard} role="status">
        <h3 className={styles.contactDoneTitle}>Thank you, we have your request.</h3>
        <p className={styles.contactDoneText}>
          A real person will get back to you, usually within one working day. If it can't wait, email{" "}
          <a href={`mailto:${email}`}>{email}</a>.
        </p>
      </div>
    )
  }

  return (
    <form className={styles.contactCard} onSubmit={onSubmit} noValidate>
      <div className={styles.contactKinds} role="radiogroup" aria-label="What would you like?">
        <button
          type="button"
          role="radio"
          aria-checked={kind === "demo"}
          className={`${styles.contactKind} ${kind === "demo" ? styles.contactKindOn : ""}`}
          onClick={() => setKind("demo")}
        >
          Book a demo
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === "contact"}
          className={`${styles.contactKind} ${kind === "contact" ? styles.contactKindOn : ""}`}
          onClick={() => setKind("contact")}
        >
          Ask a question
        </button>
      </div>

      <div className={styles.contactGrid}>
        <label className={styles.contactField}>
          <span>Your name *</span>
          <input name="name" type="text" autoComplete="name" maxLength={120} required />
        </label>
        <label className={styles.contactField}>
          <span>Business name</span>
          <input name="business" type="text" autoComplete="organization" maxLength={160} />
        </label>
        <label className={styles.contactField}>
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} />
        </label>
        <label className={styles.contactField}>
          <span>Phone / WhatsApp</span>
          <input name="phone" type="tel" autoComplete="tel" maxLength={40} />
        </label>
      </div>
      <p className={styles.contactHint}>Give us at least an email or a phone number.</p>

      <label className={styles.contactField}>
        <span>{kind === "demo" ? "Anything we should know? (optional)" : "Your question"}</span>
        <textarea name="message" rows={3} maxLength={2000} />
      </label>

      {/* Honeypot: hidden from people, tempting to bots. */}
      <div className={styles.contactTrap} aria-hidden="true">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      {error && (
        <p className={styles.contactError} role="alert">
          {error}
        </p>
      )}

      <button type="submit" className={`${styles.btn} ${styles.btnPrimary} ${styles.contactSubmit}`} disabled={pending}>
        {pending ? "Sending…" : kind === "demo" ? "Request my demo" : "Send message"}
      </button>
      <p className={styles.contactFine}>
        We only use your details to reply to this request. Prefer email? <a href={`mailto:${email}`}>{email}</a>
      </p>
    </form>
  )
}
