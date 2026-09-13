// app/onboarding/page.tsx
import { redirect } from "next/navigation"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { OnboardingForm } from "./OnboardingForm"

export const metadata = { title: "Set up your business · QLess" }

export default async function OnboardingPage() {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl text-stone-900">One more step</h1>
      <p className="mt-2 text-stone-600">Create a new business, or join one you've been invited to.</p>
      <OnboardingForm />
    </main>
  )
}
