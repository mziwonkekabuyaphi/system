// lib/handover.ts
// Place in your WhatsApp Concierge (Next.js) repo — this is where inbound
// messages are received and Claude is called, so the AI/human gate has to
// live here, not in the dashboard repo.

import type { SupabaseClient } from '@supabase/supabase-js';

export const AI_OFF_STATES = ['paused', 'human', 'handoff', 'manual'] as const;

interface ConversationStateRow {
  phone: string;
  state: string | null;
  data: Record<string, any> | null;
  updated_at: string;
}

export async function isAIEnabled(supabase: SupabaseClient, phone: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('conversation_states')
    .select('state, data')
    .eq('phone', phone)
    .maybeSingle();

  if (error) {
    console.error('[handover] isAIEnabled lookup failed, defaulting to AI ON:', error.message);
    return true; // fail open — don't silently strand a customer with no reply
  }

  if (!data || !data.state) return true;
  return !AI_OFF_STATES.includes(String(data.state).toLowerCase() as any);
}

/**
 * IMPORTANT — idempotency guard against timer-reset loops:
 *
 * Every call to this function bumps `updated_at`, and runStaleHandoffSweep
 * only auto-resumes a handoff row once `updated_at` is older than
 * `handoffStaleMinutes`. If a customer is ALREADY in `handoff` and something
 * upstream calls escalateToHuman() again (e.g. shouldEscalate() re-firing
 * on the next low-confidence message, which is common — see intent-router's
 * LOW_CONFIDENCE_FALLBACK), the naive version of this function kept pushing
 * `updated_at` forward, which restarts the stale-sweep clock from zero.
 * That turned "wait up to N minutes" into "wait N minutes from your LAST
 * message" — meaning a customer who kept texting to try to break out, or
 * who simply had more low-confidence messages come in, could get stuck
 * indefinitely.
 *
 * This now short-circuits: if `phone` is already in `handoff`, it leaves
 * the row untouched (same reason recorded, same clock ticking) instead of
 * re-upserting. A genuinely NEW escalation reason still gets appended to
 * `data` for visibility, but never touches `updated_at` while already
 * escalated. If you want repeated distinct escalation reasons to extend
 * the wait (e.g. a second, unrelated complaint), track that as an explicit
 * decision in the caller rather than as a side effect of this function.
 */
export async function escalateToHuman(
  supabase: SupabaseClient,
  phone: string,
  reason: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  const { data: existing } = await supabase
    .from('conversation_states')
    .select('state, data')
    .eq('phone', phone)
    .maybeSingle();

  if (existing?.state === 'handoff') {
    // Already escalated — record the additional reason without resetting
    // updated_at, so the stale-sweep clock keeps counting down instead of
    // restarting on every subsequent low-confidence message.
    const priorReasons: string[] = Array.isArray(existing?.data?.escalation_reasons)
      ? existing.data.escalation_reasons
      : existing?.data?.escalation_reason
        ? [existing.data.escalation_reason]
        : [];

    if (!priorReasons.includes(reason)) {
      const { error } = await supabase
        .from('conversation_states')
        .update({
          data: {
            ...(existing.data || {}),
            escalation_reasons: [...priorReasons, reason],
          },
          // updated_at intentionally NOT touched here.
        })
        .eq('phone', phone);

      if (error) console.error('[handover] escalateToHuman (repeat) failed:', error.message);
      return !error;
    }

    return true;
  }

  const { error } = await supabase.from('conversation_states').upsert({
    phone,
    state: 'handoff',
    data: { ...(existing?.data || {}), escalation_reason: reason, escalated_at: nowIso },
    updated_at: nowIso,
  });

  if (error) console.error('[handover] escalateToHuman failed:', error.message);
  return !error;
}

/**
 * Notifies your team via WhatsApp when a conversation escalates.
 *
 * IMPORTANT — 24-hour session window: WhatsApp Business API only allows
 * free-text business-initiated messages to a number that has messaged
 * your business number within the last 24 hours (Meta's "customer service
 * window"). Outside that window, this call will fail (Meta error 131047,
 * "re-engagement message"). Two ways to handle that:
 *   1. Have each team member send your bot a message occasionally (even
 *      just "hi") to keep their own window open — fine for a small team,
 *      fragile at scale.
 *   2. Send via an approved WhatsApp message template instead of free
 *      text — templates can be sent outside the window. Your Supabase
 *      schema already has a whatsapp_templates table, so once you have a
 *      Meta-approved "handoff notification" template, swap the
 *      sendWhatsAppTextMessage call below for your template-send function.
 * Shipping with free text for now since that's what's already built;
 * move to a template if team numbers go quiet for more than a day at a time.
 */
export async function notifyAgentViaWhatsApp(opts: {
  phone: string;
  reason: string;
  customerName?: string;
  teamPhones: string[];
  sendWhatsAppTextMessage: (to: string, text: string) => Promise<unknown>;
}) {
  const { phone, reason, customerName, teamPhones, sendWhatsAppTextMessage } = opts;
  if (!teamPhones || teamPhones.length === 0) return;

  const text = `🔴 Handoff needed: ${customerName || phone} (${phone})\nReason: ${reason}\nOpen the admin panel to take over.`;

  await Promise.all(
    teamPhones.map(async (teamPhone) => {
      try {
        await sendWhatsAppTextMessage(teamPhone, text);
      } catch (e) {
        console.error(
          `[handover] Failed to notify team member ${teamPhone}:`,
          e instanceof Error ? e.message : 'Unknown error'
        );
      }
    })
  );
}

export async function escalateToHumanAndNotify(
  supabase: SupabaseClient,
  phone: string,
  reason: string,
  notifyOpts: {
    customerName?: string;
    teamPhones?: string[];
    sendWhatsAppTextMessage?: (to: string, text: string) => Promise<unknown>;
  } = {}
): Promise<boolean> {
  const ok = await escalateToHuman(supabase, phone, reason);
  if (ok && notifyOpts.teamPhones?.length && notifyOpts.sendWhatsAppTextMessage) {
    await notifyAgentViaWhatsApp({
      phone,
      reason,
      customerName: notifyOpts.customerName,
      teamPhones: notifyOpts.teamPhones,
      sendWhatsAppTextMessage: notifyOpts.sendWhatsAppTextMessage,
    });
  }
  return ok;
}

/**
 * Decides whether a conversation should hand off to a human.
 *
 * Primary signal: the actual user message text, checked for explicit
 * human-request phrases. This is deliberately NOT gated on
 * `intent === "support"` — that bucket also covers a plain "thanks" at
 * confidence 1 (see checkGreetingOrThanks in intent-router.ts), so intent
 * alone isn't trustworthy for this. Matching the raw text side-steps that
 * entirely: "thanks" never matches the phrase regex below regardless of
 * which intent bucket it lands in.
 *
 * Secondary signal: `intentConfidence` below intent-router.ts's own
 * LOW_CONFIDENCE_FLOOR (0.5). The router already normalizes any result
 * that weak to a canonical "unknown" — so seeing a genuinely low
 * confidence here means the classifier itself doesn't understand the
 * message, which is a legitimate (if softer) reason to loop in a human.
 * Note this is a real routeIntent confidence when reply.ts's
 * ProcessedMessageResult is passed through — not a placeholder.
 *
 * FIXED (previously a known gap): this used to fire on `intentConfidence`
 * ALONE, with no awareness of whether action-router.ts actually produced
 * a good, deterministic reply for the message (state delegation, a
 * fast-path match, a menu tap, etc). Since intent-router normalizes a
 * large share of ordinary, ambiguous-but-harmless messages to confidence
 * 0.4 (LOW_CONFIDENCE_FALLBACK) even when action-router handled them
 * fine, that made `genuinelyLowConfidence` a much broader trigger than
 * "the customer needs a human" — it fired on a large fraction of normal
 * traffic, discarding perfectly good replies (see route.ts's `continue`
 * after escalation) and re-arming the handoff timer on every such message.
 *
 * Now requires `unhandled === true` as well — action-router.ts only sets
 * that on the two genuine "couldn't map this to anything" replies
 * (UNKNOWN_STATE_REPLY, buildUnknownIntentReply). A low-confidence
 * classification alongside an otherwise-good deterministic reply no
 * longer escalates.
 *
 * Fallback: aiResponse text regex, for callers that don't have intent
 * data available at all.
 */
export function shouldEscalate(args: {
  userMessage?: string;
  aiResponse?: string;
  intentConfidence?: number;
  unhandled?: boolean;
}): boolean {
  const text = (args.userMessage || '').toLowerCase();
  const explicitHumanRequest = /\b(talk to (a |an )?(agent|manager|human|person)|speak to (a |an )?(agent|manager|human|person)|real person|complaint|i want a refund|this is unacceptable)\b/.test(
    text
  );
  const genuinelyLowConfidence =
    typeof args.intentConfidence === 'number' &&
    args.intentConfidence < 0.5 &&
    args.unhandled === true;
  const aiPunted = /\b(i can't help with that|i'm not able to assist|contact support)\b/i.test(
    args.aiResponse || ''
  );

  return explicitHumanRequest || genuinelyLowConfidence || aiPunted;
}

/**
 * Resumes AI on `paused` (manually taken-over) conversations an agent has
 * gone quiet on for longer than staleMinutes.
 *
 * UPDATED: also resumes `handoff` (AI-escalated, e.g. "talk to a human")
 * conversations that have gone unanswered for longer than
 * handoffStaleMinutes. Previously `handoff` rows were skipped entirely —
 * a customer who asked for a human and then got no reply had no way back
 * to AI short of a manual admin-panel change. handoffStaleMinutes
 * defaults longer than staleMinutes (60 vs 30) since an explicit human
 * request deserves more patience before falling back to AI than a
 * conversation an agent merely paused; tune both independently to taste.
 *
 * Both states are still gated purely on `updated_at` staleness — if an
 * agent is actively replying (even without changing state), updated_at
 * won't move for handoff rows unless something touches the row, so make
 * sure your admin panel bumps `updated_at` (or a separate
 * `last_agent_activity_at` column) whenever an agent sends a message, or
 * a slow-but-present agent could get auto-resumed out from under them.
 * If you'd rather track that separately, swap the `.lt('updated_at', ...)`
 * filter below for a dedicated activity-timestamp column instead.
 *
 * Call this from the cron API route, not via setInterval (see route below).
 */
export async function runStaleHandoffSweep(
  supabase: SupabaseClient,
  {
    staleMinutes = 30,
    handoffStaleMinutes = 60,
  }: { staleMinutes?: number; handoffStaleMinutes?: number } = {}
): Promise<{ resumed: number; resumedPaused: number; resumedHandoff: number }> {
  const pausedCutoffIso = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const handoffCutoffIso = new Date(Date.now() - handoffStaleMinutes * 60 * 1000).toISOString();

  const [pausedResult, handoffResult] = await Promise.all([
    supabase
      .from('conversation_states')
      .select('phone, updated_at, data')
      .eq('state', 'paused')
      .lt('updated_at', pausedCutoffIso),
    supabase
      .from('conversation_states')
      .select('phone, updated_at, data')
      .eq('state', 'handoff')
      .lt('updated_at', handoffCutoffIso),
  ]);

  if (pausedResult.error) {
    console.error('[handover] runStaleHandoffSweep paused lookup failed:', pausedResult.error.message);
  }
  if (handoffResult.error) {
    console.error('[handover] runStaleHandoffSweep handoff lookup failed:', handoffResult.error.message);
  }

  const pausedRows = (pausedResult.data || []) as ConversationStateRow[];
  const handoffRows = (handoffResult.data || []) as ConversationStateRow[];

  if (!pausedRows.length && !handoffRows.length) {
    return { resumed: 0, resumedPaused: 0, resumedHandoff: 0 };
  }

  const nowIso = new Date().toISOString();
  let resumedPaused = 0;
  let resumedHandoff = 0;

  for (const row of pausedRows) {
    const { error: updErr } = await supabase
      .from('conversation_states')
      .update({
        state: 'active',
        data: { ...(row.data || {}), auto_resumed_at: nowIso, auto_resumed_reason: 'agent_inactivity' },
        updated_at: nowIso,
      })
      .eq('phone', row.phone);

    if (!updErr) resumedPaused += 1;
    else console.error(`[handover] failed to auto-resume paused ${row.phone}:`, updErr.message);
  }

  for (const row of handoffRows) {
    const { error: updErr } = await supabase
      .from('conversation_states')
      .update({
        state: 'active',
        data: {
          ...(row.data || {}),
          auto_resumed_at: nowIso,
          auto_resumed_reason: 'handoff_no_agent_response',
        },
        updated_at: nowIso,
      })
      .eq('phone', row.phone);

    if (!updErr) resumedHandoff += 1;
    else console.error(`[handover] failed to auto-resume handoff ${row.phone}:`, updErr.message);
  }

  const resumed = resumedPaused + resumedHandoff;
  console.log(
    `[handover] auto-resumed AI on ${resumedPaused}/${pausedRows.length} stale paused and ` +
      `${resumedHandoff}/${handoffRows.length} stale handoff conversation(s)`
  );
  return { resumed, resumedPaused, resumedHandoff };
}
