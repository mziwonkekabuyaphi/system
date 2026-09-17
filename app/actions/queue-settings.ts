// app/actions/queue-settings.ts
'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function setRequireServiceSelection(tenantId: string, required: boolean) {
  const supabase = createClient()

  // Assumes RLS already restricts this to tenant admins/owners via
  // tenant_members + role_permissions (e.g. a 'queue.manage' permission).
  const { error } = await supabase
    .from('queue_settings')
    .update({ require_service_selection: required, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)

  if (error) throw new Error(`Failed to update service selection setting: ${error.message}`)

  // Log it — you already have staff_activity_logs with a 'queue' category
  await supabase.from('staff_activity_logs').insert({
    tenant_id: tenantId,
    category: 'queue',
    action: required
      ? 'Enabled required service selection for queue/booking'
      : 'Disabled required service selection for queue/booking',
  })

  revalidatePath('/admin/queue/settings')
}
