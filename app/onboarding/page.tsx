import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/session-server";
import { isSalesperson } from "@/lib/tenant/current-tenant-member";
import { OnboardingForm } from "./OnboardingForm";

export const metadata = { title: "Set up your business · QLess" };

export default async function OnboardingPage() {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Commission salespeople are not shops: they have nothing to create or
  // join here, so send them to their own dashboard.
  if (await isSalesperson()) {
    redirect("/sales");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl text-stone-900">One more step</h1>
      <p className="mt-2 text-stone-600">
        Create a new business, or join one you&apos;ve been invited to.
      </p>
      <OnboardingForm />
    </main>
  );
}
