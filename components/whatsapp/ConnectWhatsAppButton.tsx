// components/whatsapp/ConnectWhatsAppButton.tsx
"use client"

/**
 * The "Connect WhatsApp" button: opens Meta's Embedded Signup popup and hands
 * the result to the server. Used by the onboarding step and the admin
 * settings panel.
 *
 * What the browser does (and does NOT do):
 *   - Loads Facebook's JS SDK and opens the popup (FB.login with your config id).
 *   - Listens for the popup's "WA_EMBEDDED_SIGNUP" message (only from facebook.com)
 *     to learn the WABA id and phone number id.
 *   - Sends code + those ids + the one-time state to the server. The server
 *     decides the tenant, checks the role, exchanges the code and validates
 *     everything with Meta. The browser never sees a token or the App Secret.
 *
 * v1 only supports NEW Cloud API numbers (popup event "FINISH"). Any other
 * outcome (a WhatsApp Business app number, "WABA only", cancelled) saves
 * nothing and shows a clear message.
 */

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  beginWhatsAppConnectAction,
  completeWhatsAppConnectAction,
  setUpWhatsAppTemplatesAction,
  type TemplateSetupResult,
} from "@/app/onboarding/whatsapp/actions"

export interface ConnectWhatsAppConfig {
  appId: string
  configId: string
  graphVersion: string
}

interface Props {
  config: ConnectWhatsAppConfig
  label?: string
  className?: string
  /** If set, ask this question first (e.g. before replacing a live number). Accepting it also means "replace". */
  confirmMessage?: string
  /** Go here after a successful connection (onboarding). Otherwise the page is refreshed. */
  redirectTo?: string
  /** Called after a successful connection, before any refresh/redirect. */
  onConnected?: () => void
}

interface FbLoginResponse {
  authResponse?: { code?: string } | null
  status?: string
}

interface FacebookSdk {
  init(params: Record<string, unknown>): void
  login(callback: (response: FbLoginResponse) => void, options: Record<string, unknown>): void
}

declare global {
  interface Window {
    FB?: FacebookSdk
    fbAsyncInit?: () => void
  }
}

interface SignupSession {
  event: string
  phoneNumberId?: string
  wabaId?: string
  errorMessage?: string
}

type Phase = "idle" | "opening" | "connecting" | "templates" | "done" | "error"

const DEFAULT_BUTTON_CLASS = "w-full rounded bg-stone-900 py-2 text-white disabled:opacity-60"
const SDK_SCRIPT_ID = "facebook-jssdk"
const SESSION_WAIT_MS = 8000

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function describeTemplates(result: TemplateSetupResult | null): string | null {
  if (!result) return null
  if (!result.success) return `Connected, but the message templates couldn't be sent to Meta yet (${result.error}). You can submit them from Settings → WhatsApp messages.`
  if (result.failed.length > 0) {
    return `Connected. ${result.submitted} message template(s) sent to Meta for review; ${result.failed.length} couldn't be sent. You can retry them from Settings → WhatsApp messages.`
  }
  if (result.submitted > 0) return `Connected. ${result.submitted} message templates were sent to Meta for review (usually a few minutes).`
  return "Connected."
}

export function ConnectWhatsAppButton({ config, label = "Connect WhatsApp", className, confirmMessage, redirectTo, onConnected }: Props) {
  const router = useRouter()
  const [sdkReady, setSdkReady] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [message, setMessage] = useState<string | null>(null)
  const sessionRef = useRef<SignupSession | null>(null)
  const busy = phase === "opening" || phase === "connecting" || phase === "templates"

  // Load and initialise Facebook's SDK once.
  useEffect(() => {
    if (window.FB) {
      setSdkReady(true)
      return
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId: config.appId, autoLogAppEvents: true, xfbml: false, version: config.graphVersion })
      setSdkReady(true)
    }
    if (!document.getElementById(SDK_SCRIPT_ID)) {
      const script = document.createElement("script")
      script.id = SDK_SCRIPT_ID
      script.async = true
      script.defer = true
      script.crossOrigin = "anonymous"
      script.src = "https://connect.facebook.net/en_US/sdk.js"
      document.body.appendChild(script)
    }
  }, [config.appId, config.graphVersion])

  // Listen for the popup's result (only messages that really come from facebook.com).
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      let host = ""
      try {
        host = new URL(event.origin).hostname
      } catch {
        return
      }
      if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return

      let payload: unknown = event.data
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload)
        } catch {
          return
        }
      }
      if (!payload || typeof payload !== "object") return

      const msg = payload as { type?: unknown; event?: unknown; data?: unknown }
      if (msg.type !== "WA_EMBEDDED_SIGNUP") return

      const data = (msg.data && typeof msg.data === "object" ? msg.data : {}) as Record<string, unknown>
      sessionRef.current = {
        event: typeof msg.event === "string" ? msg.event : "",
        phoneNumberId: asString(data.phone_number_id),
        wabaId: asString(data.waba_id),
        errorMessage: asString(data.error_message),
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const fail = useCallback((text: string) => {
    setMessage(text)
    setPhase("error")
  }, [])

  async function waitForSession(): Promise<SignupSession | null> {
    const deadline = Date.now() + SESSION_WAIT_MS
    while (Date.now() < deadline) {
      if (sessionRef.current) return sessionRef.current
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return sessionRef.current
  }

  async function finish(response: FbLoginResponse, state: string, replace: boolean) {
    const code = response.authResponse?.code
    if (!code) {
      fail("The WhatsApp sign-up wasn't completed. Nothing was changed.")
      return
    }

    setPhase("connecting")
    const session = await waitForSession()

    if (!session) {
      fail("Meta didn't send back the WhatsApp account details. Nothing was changed. Please try again.")
      return
    }
    if (session.event === "CANCEL" || session.event === "ERROR") {
      fail(session.errorMessage ? `Meta reported a problem: ${session.errorMessage}` : "The WhatsApp sign-up was cancelled. Nothing was changed.")
      return
    }
    if (session.event !== "FINISH" || !session.wabaId || !session.phoneNumberId) {
      fail(
        "That kind of WhatsApp number isn't supported yet. Please connect a new number that isn't already used in the WhatsApp or WhatsApp Business app. Nothing was changed.",
      )
      return
    }

    const result = await completeWhatsAppConnectAction({
      code,
      wabaId: session.wabaId,
      phoneNumberId: session.phoneNumberId,
      signupEvent: session.event,
      state,
      replace,
    })
    if (!result.success) {
      fail(result.error)
      return
    }

    setPhase("templates")
    let templates: TemplateSetupResult | null = null
    try {
      templates = await setUpWhatsAppTemplatesAction()
    } catch {
      templates = null
    }

    setMessage(describeTemplates(templates) ?? "Connected.")
    setPhase("done")
    onConnected?.()
    if (redirectTo) router.push(redirectTo)
    else router.refresh()
  }

  async function start() {
    if (busy) return
    const replace = Boolean(confirmMessage)
    if (confirmMessage && !window.confirm(confirmMessage)) return

    setMessage(null)
    sessionRef.current = null
    setPhase("opening")

    const begin = await beginWhatsAppConnectAction()
    if (!begin.success) {
      fail(begin.error)
      return
    }

    const FB = window.FB
    if (!FB) {
      fail("Facebook's sign-in didn't load. Check your connection or ad-blocker and try again.")
      return
    }

    FB.login(
      (response) => {
        void finish(response, begin.state, replace)
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {} },
      },
    )
  }

  const buttonText =
    phase === "opening" ? "Opening…" : phase === "connecting" ? "Connecting…" : phase === "templates" ? "Setting up messages…" : label

  return (
    <div className="space-y-2">
      <button type="button" onClick={() => void start()} disabled={busy || !sdkReady} className={className ?? DEFAULT_BUTTON_CLASS}>
        {buttonText}
      </button>
      {message && (
        <p className={`text-sm ${phase === "error" ? "text-red-600" : "text-emerald-700"}`} role={phase === "error" ? "alert" : "status"}>
          {message}
        </p>
      )}
    </div>
  )
}
