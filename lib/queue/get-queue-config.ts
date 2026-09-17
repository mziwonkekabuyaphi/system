// lib/queue/get-queue-config.ts
import { createClient } from '@/lib/supabase/server'

export async function getQueueConfig(tenantId: string) {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('queue_settings')
    .select('require_service_selection, allow_walkin_whatsapp, allow_walkin_kiosk, max_queue_size, auto_call_next')
    .eq('tenant_id', tenantId)
    .single()

  if (error) throw new Error(`Failed to load queue settings: ${error.message}`)
  return data
}
