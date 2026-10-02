// app/kiosk/[slug]/page.tsx
/**
 * Public, unauthenticated kiosk landing page for one tenant, at
 * /kiosk/[their-slug] — e.g. /kiosk/rands-cape-town if that's what
 * `tenants.slug` is set to for that shop.
 *
 * Resolves the tenant by (slug, status = 'active') using the same
 * privileged server client booking.ts/queue.ts/send-message.ts already
 * use — NOT a cookie/anon-scoped client. This matters here specifically:
 * `tenants_select` and `services_select` RLS policies only allow
 * `is_platform_admin()` or `is_tenant_member(...)` — there is no public
 * SELECT path on either table. A kiosk visitor has no auth.uid() at all,
 * so an anon-scoped read would 404 a real, active shop. This route is
 * trusted server code resolving a public slug (the same trust model the
 * WhatsApp webhook already uses for unauthenticated inbound traffic),
 * not an RLS-gated user request — so it deliberately reaches for the
 * service-role client instead.
 *
 * `tenant_branding` IS public-selectable (`tenant_branding_select: true`)
 * but is keyed 1:1 on tenant_id with every color column nullable, and a
 * tenant may have no branding row at all yet — both cases fall back to
 * the default palette below, which is also passed to KioskApp so a shop
 * that sets only one color still gets sane values for the rest.
 *
 * KIOSK CONFIG (new): tenant_branding also now carries the behavioral
 * settings admins control from Settings > Kiosk — tagline,
 * idle_refresh_seconds, confirmation_refresh_seconds, registration_type
 * (migration_kiosk_settings.sql). Same fallback posture as the colors:
 * NULL/no-row means "hasn't configured it yet", not an error, so every
 * field below has an explicit default matched to what KioskApp used to
 * hardcode (75s idle, "Tap anywhere to check in", etc).
 *
 * SCREEN WORDING (new): tenant_branding also carries choice_title,
 * booking_card_title, booking_card_subtitle, queue_card_title,
 * queue_card_subtitle, service_screen_title, date_screen_title,
 * time_screen_title, details_screen_title, ticket_booking_eyebrow, and
 * ticket_queue_eyebrow (migration_kiosk_wording.sql) — the copy on every
 * screen in the kiosk flow after welcome, which used to be hardcoded in
 * components/kiosk/KioskApp.tsx (ChoiceScreen / ServiceScreen /
 * DateScreen / TimeScreen / DetailsScreen / TicketScreen). Same
 * NULL-means-default posture as everything else here. time_screen_title
 * is a PREFIX, not the full heading — TimeScreen appends
 * " — {date label}" itself (e.g. "Pick a time — Today", "Pick a time —
 * Fri 19 Sep"), so a tenant only configures the part before the dash.
 * ticket_booking_eyebrow/ticket_queue_eyebrow are the small label above
 * the ticket number on the final confirmation screen, one per path.
 * Registration-type scoping: service_screen_title and
 * details_screen_title apply on every path; date_screen_title and
 * time_screen_title only ever render on the booking path; the two ticket
 * eyebrows are each scoped to their own path.
 *
 * NEXT.JS 15/16 FIX: `params` is now a Promise (not a plain object) in
 * route/page components — must be awaited before use. The old sync
 * `{ params: { slug: string } }` shape silently resolved `params.slug`
 * to `undefined`, which made loadKioskData(undefined) return null via
 * an empty (not erroring) Supabase query, which triggered notFound() —
 * a real tenant 404'ing with zero errors logged anywhere. Both the page
 * component and generateMetadata needed this fix, since each
 * independently destructures `params`.
 *
 * KIOSK-AVAILABILITY GATE: a tenant existing and being active (checked
 * above) is not the same as that tenant having the kiosk *module* turned
 * on — that's a separate on/off switch admins flip from Settings
 * (setKioskEnabled in app/admin/settings-actions.ts), keyed on
 * `modules.key = 'kiosk'` / `tenant_modules.enabled`. This route reuses
 * that exact lookup (see resolveKioskModuleEnabled below) so a tenant
 * that's paused their kiosk gets an explicit "not available" screen
 * instead of the booking flow. This check happens here, server-side, in
 * loadKioskData — before KioskApp is ever rendered and before
 * getBookableServices() is ever called — not as a client-side redirect
 * after the flow has already mounted. No tenant_modules row for 'kiosk'
 * is treated the same as `enabled: false` (fail closed): an unprovisioned
 * module is not an on module.
 */

import { notFound } from "next/navigation"
import { Manrope } from "next/font/google"

import { getSupabaseServerClient } from "@/lib/supabase/admin"
import { getBookableServices } from "@/lib/services/shared/services-catalog"
import { isKioskEnabled, shouldShowPoweredBy } from "@/lib/services/plans"
import { KioskApp } from "@/components/kiosk/KioskApp"

const manrope = Manrope({ subsets: ["latin"], weight: ["500", "600", "700", "800"] })

// Kiosk data (services, branding) can change any time a shop owner edits
// their catalog, colors, or kiosk config — a walk-in kiosk should never
// serve a cached version of any of it.
export const dynamic = "force-dynamic"

export type KioskRegistrationType = "booking" | "queue" | "both"

export interface KioskBranding {
  displayName: string
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
  removePoweredBy: boolean
  tagline: string
  idleRefreshSeconds: number
  confirmationRefreshSeconds: number
  registrationType: KioskRegistrationType
  // Screen wording — admin-configurable from Settings > Kiosk (see
  // updateKioskSettings in app/admin/settings-actions.ts). Every field is
  // already resolved to a non-null display string here, same fallback
  // posture as tagline above, so KioskApp/ChoiceScreen never has to think
  // about null.
  choiceTitle: string
  bookingCardTitle: string
  bookingCardSubtitle: string
  queueCardTitle: string
  queueCardSubtitle: string
  serviceScreenTitle: string
  dateScreenTitle: string
  timeScreenTitle: string
  detailsScreenTitle: string
  ticketBookingEyebrow: string
  ticketQueueEyebrow: string
}

// Fallback palette from the design brief. tenant_branding.primary_color
// overrides `primaryColor` (used for the main accent/CTA color);
// secondary_color overrides `secondaryColor` (used for the ticket-stub
// accent). Every other token (ink, paper, line, muted) is structural,
// not brand, and stays fixed regardless of tenant.
const DEFAULT_PRIMARY_COLOR = "#2B6F5C" // accent
const DEFAULT_SECONDARY_COLOR = "#C97A3D" // ticket-amber

// Kiosk config defaults — these match what KioskApp used to hardcode
// before it became admin-configurable, so an unconfigured tenant's kiosk
// behaves exactly as it always has.
const DEFAULT_TAGLINE = "Tap anywhere to check in"
const DEFAULT_IDLE_REFRESH_SECONDS = 75
const DEFAULT_CONFIRMATION_REFRESH_SECONDS = 12
const DEFAULT_REGISTRATION_TYPE: KioskRegistrationType = "both"
const VALID_REGISTRATION_TYPES: KioskRegistrationType[] = ["booking", "queue", "both"]

// Wording defaults — the exact strings ChoiceScreen used to hardcode.
// Must stay in sync with the placeholder text shown in
// app/admin/SettingsManager.tsx's KioskBehaviorPanel, so an admin who
// hasn't customized anything sees the same copy their kiosk is actually
// rendering.
const DEFAULT_CHOICE_TITLE = "How can we help you today?"
const DEFAULT_BOOKING_CARD_TITLE = "Book a time"
const DEFAULT_BOOKING_CARD_SUBTITLE = "Pick a date and time that works for you"
const DEFAULT_QUEUE_CARD_TITLE = "Join the queue"
const DEFAULT_QUEUE_CARD_SUBTITLE = "Walk in now and we'll call you"
const DEFAULT_SERVICE_SCREEN_TITLE = "What are you here for?"
const DEFAULT_DATE_SCREEN_TITLE = "Which day works for you?"
const DEFAULT_TIME_SCREEN_TITLE = "Pick a time"
const DEFAULT_DETAILS_SCREEN_TITLE = "Almost done — who are we booking for?"
const DEFAULT_TICKET_BOOKING_EYEBROW = "Your booking"
const DEFAULT_TICKET_QUEUE_EYEBROW = "Your place in line"

interface TenantRow {
  id: string
  name: string
  slug: string
  status: string
}

interface TenantBrandingRow {
  display_name: string | null
  logo_url: string | null
  primary_color: string | null
  secondary_color: string | null
  remove_powered_by: boolean | null
  tagline: string | null
  idle_refresh_seconds: number | null
  confirmation_refresh_seconds: number | null
  registration_type: string | null
  choice_title: string | null
  booking_card_title: string | null
  booking_card_subtitle: string | null
  queue_card_title: string | null
  queue_card_subtitle: string | null
  service_screen_title: string | null
  date_screen_title: string | null
  time_screen_title: string | null
  details_screen_title: string | null
  ticket_booking_eyebrow: string | null
  ticket_queue_eyebrow: string | null
}

// Per-tenant queue behavior that KioskApp needs but that doesn't live on
// tenant_branding — pulled from queue_settings alongside everything else
// this route resolves server-side. Defaults to `true` (service required)
// on any missing row or query error, matching the DB column default —
// fail closed, since skipping a service prompt is the more surprising
// behavior for a tenant that never configured this.
interface KioskQueueBehavior {
  requireServiceSelection: boolean
}

const DEFAULT_REQUIRE_SERVICE_SELECTION = true

type KioskLoadResult =
  | {
      tenant: TenantRow
      branding: KioskBranding
      kioskEnabled: true
      services: Awaited<ReturnType<typeof getBookableServices>>
      queueBehavior: KioskQueueBehavior
    }
  | { tenant: TenantRow; branding: KioskBranding; kioskEnabled: false; services: []; queueBehavior: KioskQueueBehavior }

// Is the kiosk live for this tenant? The rule lives in plans.ts's
// isKioskEnabled(): the plan must include the kiosk module, and the tenant
// must not have switched it off in Settings > Kiosk (setKioskEnabled in
// app/admin/settings-actions.ts). No tenant_modules row means "never
// touched" and counts as ON. Any lookup error counts as OFF -- a booking
// flow silently failing open on a bad lookup would be far worse than an
// idle kiosk correctly showing "not available."
async function resolveKioskModuleEnabled(
  supabase: NonNullable<ReturnType<typeof getSupabaseServerClient>>,
  tenantId: string,
): Promise<boolean> {
  // Automatic on any plan that includes the kiosk (Growth/Business);
  // only an explicit "off" from the tenant's admin disables it, and a
  // downgrade to Mahala shuts it off immediately. Fails closed on error.
  return isKioskEnabled(supabase, tenantId)
}

function resolveRegistrationType(value: string | null | undefined): KioskRegistrationType {
  if (value && (VALID_REGISTRATION_TYPES as string[]).includes(value)) {
    return value as KioskRegistrationType
  }
  return DEFAULT_REGISTRATION_TYPE
}

async function loadKioskData(slug: string): Promise<KioskLoadResult | null> {
  const supabase = getSupabaseServerClient()
  if (!supabase) throw new Error("Supabase server client is unavailable")

  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("id, name, slug, status")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle<TenantRow>()

  if (tenantError) throw new Error(`Failed to resolve tenant for slug "${slug}": ${tenantError.message}`)
  if (!tenant) return null

  const { data: branding } = await supabase
    .from("tenant_branding")
    .select(
      "display_name, logo_url, primary_color, secondary_color, remove_powered_by, tagline, idle_refresh_seconds, confirmation_refresh_seconds, registration_type, choice_title, booking_card_title, booking_card_subtitle, queue_card_title, queue_card_subtitle, service_screen_title, date_screen_title, time_screen_title, details_screen_title, ticket_booking_eyebrow, ticket_queue_eyebrow",
    )
    .eq("tenant_id", tenant.id)
    .maybeSingle<TenantBrandingRow>()

  const resolvedBranding: KioskBranding = {
    displayName: branding?.display_name || tenant.name,
    logoUrl: branding?.logo_url ?? null,
    primaryColor: branding?.primary_color || DEFAULT_PRIMARY_COLOR,
    secondaryColor: branding?.secondary_color || DEFAULT_SECONDARY_COLOR,
    // No row (tenant hasn't touched branding yet) and NULL (column default)
    // both mean "hasn't been granted/enabled" — false either way. This is
    // also independent of `plan`: a tenant that downgrades off Business
    // after having it set stays governed by whatever's actually stored
    // here, since that's what updateBranding's own plan check maintains.
    removePoweredBy: false, // resolved below, once the plan check has run
    tagline: branding?.tagline?.trim() || DEFAULT_TAGLINE,
    idleRefreshSeconds: branding?.idle_refresh_seconds ?? DEFAULT_IDLE_REFRESH_SECONDS,
    confirmationRefreshSeconds: branding?.confirmation_refresh_seconds ?? DEFAULT_CONFIRMATION_REFRESH_SECONDS,
    registrationType: resolveRegistrationType(branding?.registration_type),
    choiceTitle: branding?.choice_title?.trim() || DEFAULT_CHOICE_TITLE,
    bookingCardTitle: branding?.booking_card_title?.trim() || DEFAULT_BOOKING_CARD_TITLE,
    bookingCardSubtitle: branding?.booking_card_subtitle?.trim() || DEFAULT_BOOKING_CARD_SUBTITLE,
    queueCardTitle: branding?.queue_card_title?.trim() || DEFAULT_QUEUE_CARD_TITLE,
    queueCardSubtitle: branding?.queue_card_subtitle?.trim() || DEFAULT_QUEUE_CARD_SUBTITLE,
    serviceScreenTitle: branding?.service_screen_title?.trim() || DEFAULT_SERVICE_SCREEN_TITLE,
    dateScreenTitle: branding?.date_screen_title?.trim() || DEFAULT_DATE_SCREEN_TITLE,
    timeScreenTitle: branding?.time_screen_title?.trim() || DEFAULT_TIME_SCREEN_TITLE,
    detailsScreenTitle: branding?.details_screen_title?.trim() || DEFAULT_DETAILS_SCREEN_TITLE,
    ticketBookingEyebrow: branding?.ticket_booking_eyebrow?.trim() || DEFAULT_TICKET_BOOKING_EYEBROW,
    ticketQueueEyebrow: branding?.ticket_queue_eyebrow?.trim() || DEFAULT_TICKET_QUEUE_EYEBROW,
  }

  // The stored flag only counts while the tenant's CURRENT plan still
  // includes remove_powered_by. Without this, a tenant that downgrades off
  // Business keeps the label hidden forever. shouldShowPoweredBy fails
  // open (label stays) if the plan lookup errors.
  if (branding?.remove_powered_by === true && !(await shouldShowPoweredBy(supabase, tenant.id))) {
    resolvedBranding.removePoweredBy = true
  }

  const kioskEnabled = await resolveKioskModuleEnabled(supabase, tenant.id)

  // Same fail-closed posture as resolveKioskModuleEnabled above: a missing
  // row or query error means "behave as if service selection is
  // required", not "silently skip it" — an admin who hasn't touched this
  // setting yet gets the flow they already had.
  const { data: queueSettingsRow, error: queueSettingsError } = await supabase
    .from("queue_settings")
    .select("require_service_selection")
    .eq("tenant_id", tenant.id)
    .maybeSingle()

  if (queueSettingsError) {
    console.error("[kiosk] queue_settings lookup failed", { tenantId: tenant.id, error: queueSettingsError })
  }

  const queueBehavior: KioskQueueBehavior = {
    requireServiceSelection: queueSettingsRow?.require_service_selection ?? DEFAULT_REQUIRE_SERVICE_SELECTION,
  }

  // Don't even touch the services catalog when the module's off — the
  // whole point of a server-side gate is that the booking flow's data
  // never loads for a kiosk that shouldn't be running it.
  if (!kioskEnabled) {
    return { tenant, branding: resolvedBranding, kioskEnabled: false, services: [], queueBehavior }
  }

  const services = await getBookableServices(tenant.id)

  return { tenant, branding: resolvedBranding, kioskEnabled: true, services, queueBehavior }
}

export default async function KioskPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  if (!data) notFound()

  const { tenant, branding, kioskEnabled, services, queueBehavior } = data

  if (!kioskEnabled) {
    return (
      <div className={manrope.className}>
        <KioskUnavailable branding={branding} />
      </div>
    )
  }

  return (
    <div className={manrope.className}>
      <KioskApp
        slug={tenant.slug}
        branding={branding}
        initialServices={services}
        requireServiceSelection={queueBehavior.requireServiceSelection}
      />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Kiosk-module-off state — deliberately plain: no idle timer, no tap
// target, nothing for a walk-in to interact with. Uses the same
// paper/ink/accent tokens KioskApp's own <style jsx> uses so a paused
// kiosk still looks like it belongs to the shop, not like a generic error
// page. Plain inline styles here (not styled-jsx like KioskApp) because
// this renders inside KioskPage, a Server Component — styled-jsx's
// runtime only works under a "use client" boundary, which is exactly
// what KioskApp has and this doesn't need.
// ----------------------------------------------------------------------------

const UNAVAILABLE_INK = "#171412"
const UNAVAILABLE_PAPER = "#FAF8F5"
const UNAVAILABLE_MUTED = "#6B655C"

function KioskUnavailable({ branding }: { branding: KioskBranding }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: UNAVAILABLE_PAPER,
        color: UNAVAILABLE_INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: 40,
        textAlign: "center",
      }}
    >
      {branding.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={branding.logoUrl}
          alt=""
          style={{ maxHeight: 96, maxWidth: 320, objectFit: "contain", marginBottom: 8 }}
        />
      )}
      <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0, color: UNAVAILABLE_INK, lineHeight: 1.1 }}>
        {branding.displayName}
      </h1>
      <p style={{ fontSize: 26, fontWeight: 700, color: branding.primaryColor, margin: 0 }}>
        This kiosk isn&apos;t available right now.
      </p>
      <p style={{ fontSize: 19, fontWeight: 500, color: UNAVAILABLE_MUTED, margin: 0 }}>
        Please check in at the counter instead.
      </p>
    </div>
  )
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadKioskData(slug)
  if (!data) return { title: "Kiosk" }

  return {
    title: data.kioskEnabled ? `${data.branding.displayName} — Check in` : `${data.branding.displayName} — Kiosk unavailable`,
  }
}
