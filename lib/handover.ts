// lib/handover.ts
// Tenant-scoped AI/human handover gate. Same logic as the single-tenant
// original, but every function now takes tenantId and queries
// conversation_states on (tenant_id, phone) instead of phone alone,
// matching the new unique(tenant_id, phone) constraint.

import type { SupabaseClient } from '@supabase/supabase-js';

export const AI_OFF_STATES = ['paused', 'human', 'handoff', 'manual'] as const;

interface ConversationStateRow {
  tenant_id: string;
  phone: string;
  state: string | null;
  data: Record<string, any> | null;
  updated_at: string;
}

export async function isAIEnabled(supabase: SupabaseClient, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('conversation_states')
    .select('state, data')
    .eq('tenant_id', tenantId)
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
 * IMPORTANT — idempotency guard against timer-reset loops. Same reasoning
 * as the single-tenant version: repeated escalation calls for an already-
 * handed-off (tenant, phone) must not keep bumping updated_at, or the
 * stale-sweep clock never advances. See runStaleHandoffSweep below.
 */
export async function escalateToHuman(
  supabase: SupabaseClient,
  tenantId: string,
  phone: string,
  reason: string
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  const { data: existing } = await supabase
    .from('conversation_states')
    .select('state, data')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .maybeSingle();

  if (existing?.state === 'handoff') {
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
        .eq('tenant_id', tenantId)
        .eq('phone', phone);

      if (error) console.error('[handover] escalateToHuman (repeat) failed:', error.message);
      return !error;
    }

    return true;
  }

  const { error } = await supabase.from('conversation_states').upsert(
    {
      tenant_id: tenantId,
      phone,
      state: 'handoff',
      data: { ...(existing?.data || {}), escalation_reason: reason, escalated_at: nowIso },
      updated_at: nowIso,
    },
    { onConflict: 'tenant_id,phone' },
  );

  if (error) console.error('[handover] escalateToHuman failed:', error.message);
  return !error;
}

/**
 * Notifies your team via WhatsApp when a conversation escalates.
 *
 * IMPORTANT — 24-hour session window: same caveat as before, AND now also
 * tenant-specific credentials. `sendWhatsAppTextMessage` is passed in by
 * the caller (route.ts) already bound to the correct tenant's WhatsApp
 * integration — this file has no knowledge of which tenant's credentials
 * are being used, by design (keeps this file free of send-message.ts's
 * per-tenant Vault lookup concerns).
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
  tenantId: string,
  phone: string,
  reason: string,
  notifyOpts: {
    customerName?: string;
    teamPhones?: string[];
    sendWhatsAppTextMessage?: (to: string, text: string) => Promise<unknown>;
  } = {}
): Promise<boolean> {
  const ok = await escalateToHuman(supabase, tenantId, phone, reason);
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
 * Decides whether a conversation should hand off to a human. Unchanged
 * from the single-tenant version — this is pure text/confidence logic
 * with no tenant awareness needed.
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
 * Resumes AI on stale paused/handoff conversations, across ALL tenants —
 * this is a platform-wide cron sweep, not scoped to one tenant. Each
 * resumed row now carries its own tenant_id alongside phone.
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
      .select('tenant_id, phone, updated_at, data')
      .eq('state', 'paused')
      .lt('updated_at', pausedCutoffIso),
    supabase
      .from('conversation_states')
      .select('tenant_id, phone, updated_at, data')
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
      .eq('tenant_id', row.tenant_id)
      .eq('phone', row.phone);

    if (!updErr) resumedPaused += 1;
    else console.error(`[handover] failed to auto-resume paused ${row.tenant_id}/${row.phone}:`, updErr.message);
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
      .eq('tenant_id', row.tenant_id)
      .eq('phone', row.phone);

    if (!updErr) resumedHandoff += 1;
    else console.error(`[handover] failed to auto-resume handoff ${row.tenant_id}/${row.phone}:`, updErr.message);
  }

  const resumed = resumedPaused + resumedHandoff;
  console.log(
    `[handover] auto-resumed AI on ${resumedPaused}/${pausedRows.length} stale paused and ` +
      `${resumedHandoff}/${handoffRows.length} stale handoff conversation(s)`
  );
  return { resumed, resumedPaused, resumedHandoff };
}
