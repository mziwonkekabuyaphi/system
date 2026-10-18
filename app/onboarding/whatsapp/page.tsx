// app/onboarding/whatsapp/page.tsx
import Link from "next/link"
import { redirect } from "next/navigation"

import { ConnectWhatsAppButton } from "@/components/whatsapp/ConnectWhatsAppButton"
import { getConnectContext, loadConnectionStatus } from "@/lib/whatsapp/embedded-signup/status"

export const metadata = { title: "Connect WhatsApp · QLess" }

// Connecting talks to Meta several times in a row; give the server action room.
export const maxDuration = 60

/**
 * Optional step shown right after "Create business".
 *
 * It only appears when it can actually work. In every other case the visitor is
 * sent straight to /admin, so nothing about signup or onboarding can get stuck here:
 *   - not signed in            -> /login
 *   - no business yet          -> /onboarding
 *   - not the owner            -> /admin
 *   - plan has no WhatsApp     -> /admin  (Mahala/free)
 *   - Meta isn't configured    -> /admin  (env vars not set yet)
 *   - already connected        -> /admin
 */
export default async function OnboardingWhatsAppPage() {
  const ctx = await getConnectContext()
  if (!ctx.ok) redirect(ctx.reason === "signed_out" ? "/login?next=/onboarding/whatsapp" : "/onboarding")
  if (ctx.block !== null) redirect("/admin")

  const status = await loadConnectionStatus(ctx.tenantId)
  if (status.state === "connected") redirect("/admin")

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl text-stone-900">Connect your WhatsApp</h1>
      <p className="mt-2 text-stone-600">
        Let customers book, join the queue and get updates on your own WhatsApp number.
      </p>

      <ul className="mt-6 space-y-2 text-sm text-stone-600">
        <li>You&apos;ll sign in with Meta (Facebook) in a pop-up and choose or create your WhatsApp Business account. We never see your password.</li>
        <li>Use a number that isn&apos;t already used in the WhatsApp or WhatsApp Business app.</li>
        <li>Meta bills you directly for WhatsApp messages. You&apos;ll add a payment method in WhatsApp Manager.</li>
      </ul>

      {status.state === "error" && status.lastError && (
        <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          Last attempt didn&apos;t finish: {status.lastError}
        </p>
      )}

      <div className="mt-8 space-y-4">
        <ConnectWhatsAppButton config={ctx.config} redirectTo="/admin" />
        <Link href="/admin" className="block text-center text-sm text-stone-500 underline">
          Skip for now
        </Link>
        <p className="text-center text-xs text-stone-400">You can connect WhatsApp any time in Settings.</p>
      </div>
    </main>
  )
}
