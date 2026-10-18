"use server"

// app/onboarding/whatsapp/actions.ts
/**
 * Server actions behind the "Connect WhatsApp" button (onboarding step AND the
 * admin settings panel).
 *
 * TENANT AND ROLE NEVER COME FROM THE BROWSER. Every action works out the
 * tenant from the signed-in user's active tenant_members row
 * (getCurrentTenantMember via getConnectContext) and requires the
 * tenant_owner role. None of these functions accepts a tenant id.
 *
 * CSRF / replay: beginWhatsAppConnectAction sets a random, single-use,
 * HTTP-only cookie (bound to the tenant) and returns the same random value;
 * completeWhatsAppConnectAction only proceeds if the browser sends that value
 * back AND still holds the matching cookie, and the cookie is deleted on first
 * use. This sits on top of Next.js's own same-origin check for server actions.
 *
 * Access tokens and the App Secret never leave the server; nothing returned to
 * the browser contains one.
 */

import { randomBytes, timingSafeEqual } from "crypto"
import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"

import { connectWhatsApp, type ConnectErrorCode } from "@/lib/whatsapp/embedded-signup/connect"
import {
  getConnectContext,
  loadConnectionStatus,
  type ConnectBlock,
  type ConnectConfig,
  type ConnectionStatus,
} from "@/lib/whatsapp/embedded-signup/status"
import { loadWhatsAppTemplates, seedWhatsAppTemplates, submitWhatsAppTemplate } from "@/app/admin/whatsapp-template-actions"

const STATE_COOKIE = "wa_connect_state"
const STATE_MAX_AGE_SECONDS = 10 * 60

const BLOCK_MESSAGES: Record<ConnectBlock, string> = {
  not_owner: "Only the business owner can connect WhatsApp.",
  plan: "WhatsApp isn't included in your current plan. Upgrade in Billing to connect it.",
  not_configured: "Connecting WhatsApp yourself isn't available on this platform yet. Please contact support.",
}

const NOT_SIGNED_IN = "You need to be signed in to a business to do this."

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again."
}

// ---------------------------------------------------------------------------
// Status for the settings panel
// ---------------------------------------------------------------------------
export type ConnectionPanelData =
  | { success: true; status: ConnectionStatus; block: null; config: ConnectConfig }
  | { success: true; status: ConnectionStatus; block: ConnectBlock; config: null }
  | { success: false; error: string }

export async function getWhatsAppConnectionPanelAction(): Promise<ConnectionPanelData> {
  try {
    const ctx = await getConnectContext()
    if (!ctx.ok) return { success: false, error: NOT_SIGNED_IN }
    const status = await loadConnectionStatus(ctx.tenantId)
    if (ctx.block === null) return { success: true, status, block: null, config: ctx.config }
    return { success: true, status, block: ctx.block, config: null }
  } catch (error) {
    return { success: false, error: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Step 1: called just before the Meta popup opens
// ---------------------------------------------------------------------------
export async function beginWhatsAppConnectAction(): Promise<{ success: true; state: string } | { success: false; error: string }> {
  try {
    const ctx = await getConnectContext()
    if (!ctx.ok) return { success: false, error: NOT_SIGNED_IN }
    if (ctx.block !== null) return { success: false, error: BLOCK_MESSAGES[ctx.block] }

    const state = randomBytes(24).toString("base64url")
    const store = await cookies()
    store.set(STATE_COOKIE, `${ctx.tenantId}.${state}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: STATE_MAX_AGE_SECONDS,
    })
    return { success: true, state }
  } catch (error) {
    return { success: false, error: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Step 2: called when the popup finished
// ---------------------------------------------------------------------------
export interface CompleteWhatsAppConnectInput {
  /** The one-time code from FB.login (valid for about 30 seconds). */
  code: string
  wabaId: string
  phoneNumberId: string
  /** The popup's own event name. Only "FINISH" (a new Cloud API number) is accepted in v1. */
  signupEvent: string
  /** The value beginWhatsAppConnectAction returned. */
  state: string
  /** The owner confirmed they may replace a different, currently active number. */
  replace: boolean
}

export type CompleteWhatsAppConnectResult =
  | { success: true; displayPhone: string | null }
  | { success: false; error: string; code?: ConnectErrorCode }

export async function completeWhatsAppConnectAction(input: CompleteWhatsAppConnectInput): Promise<CompleteWhatsAppConnectResult> {
  try {
    const ctx = await getConnectContext()
    if (!ctx.ok) return { success: false, error: NOT_SIGNED_IN }
    if (ctx.block !== null) return { success: false, error: BLOCK_MESSAGES[ctx.block] }

    // Single-use state: read it, then delete it straight away, even if everything after fails.
    const store = await cookies()
    const stored = store.get(STATE_COOKIE)?.value ?? ""
    store.delete(STATE_COOKIE)
    const sentState = typeof input?.state === "string" ? input.state : ""
    if (!safeEqual(stored, `${ctx.tenantId}.${sentState}`)) {
      return { success: false, error: "This sign-up session expired. Please press Connect again." }
    }

    if (
      typeof input.code !== "string" ||
      typeof input.wabaId !== "string" ||
      typeof input.phoneNumberId !== "string" ||
      !input.code ||
      !input.wabaId ||
      !input.phoneNumberId
    ) {
      return { success: false, error: "The sign-up details from Meta looked incomplete. Please try again." }
    }

    if (input.signupEvent !== "FINISH") {
      return {
        success: false,
        error:
          "That kind of WhatsApp number isn't supported yet. Please connect a new number that isn't already used in the WhatsApp or WhatsApp Business app.",
      }
    }

    const result = await connectWhatsApp({
      tenantId: ctx.tenantId,
      code: input.code,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      replace: input.replace === true,
    })
    if (!result.ok) return { success: false, error: result.message, code: result.code }

    revalidatePath("/admin")
    return { success: true, displayPhone: result.displayPhone }
  } catch (error) {
    console.error("[whatsapp-connect] complete action failed", { error: messageOf(error) })
    return { success: false, error: "Something went wrong while connecting WhatsApp. Please try again." }
  }
}

// ---------------------------------------------------------------------------
// Step 3 (after the connection is active): create + submit the default templates
// ---------------------------------------------------------------------------
export type TemplateSetupResult =
  | { success: true; submitted: number; failed: Array<{ key: string; error: string }> }
  | { success: false; error: string }

/**
 * Uses the EXISTING template code (seed / submit), so wording, validation and
 * Meta payloads stay identical. Seeds only when the tenant has no templates at
 * all, and submits only templates still in "draft": a tenant that already has
 * templates (approved, pending, rejected...) is left exactly as it is.
 */
export async function setUpWhatsAppTemplatesAction(): Promise<TemplateSetupResult> {
  try {
    const ctx = await getConnectContext()
    if (!ctx.ok) return { success: false, error: NOT_SIGNED_IN }
    if (!ctx.isOwner) return { success: false, error: BLOCK_MESSAGES.not_owner }

    let loaded = await loadWhatsAppTemplates()
    if (!loaded.success) return { success: false, error: loaded.error }
    if (!loaded.connected) return { success: false, error: "WhatsApp isn't active yet." }

    if (loaded.templates.length === 0) {
      const seeded = await seedWhatsAppTemplates()
      if (!seeded.success) return { success: false, error: seeded.error }
      loaded = await loadWhatsAppTemplates()
      if (!loaded.success) return { success: false, error: loaded.error }
    }

    let submitted = 0
    const failed: Array<{ key: string; error: string }> = []
    for (const template of loaded.templates) {
      if (template.status !== "draft") continue
      const result = await submitWhatsAppTemplate(template.key)
      if (result.success) submitted += 1
      else failed.push({ key: template.key, error: result.error })
    }

    revalidatePath("/admin")
    return { success: true, submitted, failed }
  } catch (error) {
    return { success: false, error: messageOf(error) }
  }
}
