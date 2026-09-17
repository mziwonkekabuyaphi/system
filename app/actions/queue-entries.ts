// app/actions/queue-entries.ts
'use server'

import { createClient } from '@/lib/supabase/server'
import { getQueueConfig } from '@/lib/queue/get-queue-config'

export async function joinQueue(params: {
  tenantId: string
  customerId: string
  serviceId?: string | null
  source: 'walk_in' | 'booking'
}) {
  const supabase = createClient()
  const config = await getQueueConfig(params.tenantId)

  if (config.require_service_selection && !params.serviceId) {
    return { error: 'A service must be selected to join this queue.' }
  }

  const { data, error } = await supabase
    .from('queue_entries')
    .insert({
      tenant_id: params.tenantId,
      customer_id: params.customerId,
      service_id: config.require_service_selection ? params.serviceId : (params.serviceId ?? null),
      source: params.source,
      status: 'waiting',
    })
    .select()
    .single()

  if (error) return { error: error.message }
  return { data }
}
