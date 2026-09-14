"use client"

// lib/kiosk/printTicket.ts
/**
 * Calls the local print-agent running on the kiosk PC (see
 * print-agent/server.js), which talks to the USB Epson TM-T88V via the
 * TM Virtual Port Driver. This is a plain client-side fetch to
 * 127.0.0.1 — NOT a Server Action — because the agent only exists on the
 * physical machine sitting next to the printer, not on wherever this
 * Next.js app is actually hosted.
 *
 * Deliberately best-effort, same posture as the WhatsApp confirmation
 * sends in app/kiosk/[slug]/actions.ts: a printer being off, out of
 * paper, or the agent not running must never block the on-screen ticket.
 * Callers should treat a `false` return as "show a friendly fallback",
 * not as an error to surface loudly.
 */

import type { KioskBookingTicket, KioskQueueTicket } from "@/app/kiosk/[slug]/actions"

type Ticket = KioskBookingTicket | KioskQueueTicket

// Overridable via env so a kiosk PC running the agent on a different
// port doesn't require a code change — falls back to the agent's
// default of 127.0.0.1:4000.
const PRINT_AGENT_URL = process.env.NEXT_PUBLIC_PRINT_AGENT_URL || "http://127.0.0.1:4000/print-ticket"

export async function printKioskTicket(ticket: Ticket, shopName: string): Promise<boolean> {
  try {
    const res = await fetch(PRINT_AGENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, shopName }),
      // Short timeout — an unreachable agent (not running, printer PC
      // off) should fail fast rather than hang the kiosk UI.
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch (error) {
    console.warn("[kiosk] Ticket print failed", error)
    return false
  }
}
