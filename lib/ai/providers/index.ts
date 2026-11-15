// lib/ai/providers/index.ts
import { anthropicProvider } from "@/lib/ai/providers/anthropic"
import { openaiProvider } from "@/lib/ai/providers/openai"
import type { AiProvider, AiProviderId } from "@/lib/ai/providers/types"

export type { AiCallSettings, AiErrorCode, AiProvider, AiProviderError, AiProviderId, KeyCheck } from "@/lib/ai/providers/types"

// To add a vendor: implement AiProvider, register it here, and add its models to public.ai_model_pricing.
const PROVIDERS: Record<AiProviderId, AiProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
}

export function getProvider(id: string): AiProvider | null {
  return (PROVIDERS as Record<string, AiProvider | undefined>)[id] ?? null
}

export function listProviders(): AiProvider[] {
  return Object.values(PROVIDERS)
}
