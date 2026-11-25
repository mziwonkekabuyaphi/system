import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/session-server";
import { getSupabaseServerClient } from "@/lib/supabase/admin";
import { isSalesperson } from "@/lib/tenant/current-tenant-member";
import { getPlatformAdminId } from "@/lib/sales/auth";
import { OnboardingForm, type ModuleOption, type PresetOption } from "./OnboardingForm";

export const metadata = { title: "Set up your business · QLess" };
export const dynamic = "force-dynamic";

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
  if (await getPlatformAdminId()) {
    redirect("/platform");
  }
  if (await isSalesperson()) {
    redirect("/sales");
  }

  // Presets and module names live in the database (industry_presets / modules),
  // so tuning a preset never needs a deploy. Read with the service client so
  // this never depends on RLS for a brand-new user.
  const admin = getSupabaseServerClient();
  let presets: PresetOption[] = [];
  let modules: ModuleOption[] = [];
  let requires: Record<string, string[][]> = {};

  if (admin) {
    const [presetRes, moduleRes, requiresRes] = await Promise.all([
      admin
        .from("industry_presets")
        .select("key, name, emoji, description, modules")
        .eq("is_active", true)
        .order("sort_order"),
      admin
        .from("modules")
        .select("key, name, description, display_order, self_serve")
        .in("kind", ["product", "addon"])
        .neq("key", "custom_domain")
        .order("display_order", { nullsFirst: false }),
      admin.from("module_requires").select("module_key, requires_key, requirement_group"),
    ]);

    presets = (presetRes.data ?? []) as PresetOption[];
    modules = (moduleRes.data ?? []) as ModuleOption[];

    // module -> list of groups; a group is satisfied when ANY key in it is on.
    const grouped: Record<string, Record<number, string[]>> = {};
    for (const row of requiresRes.data ?? []) {
      const byGroup = (grouped[row.module_key] ??= {});
      (byGroup[row.requirement_group] ??= []).push(row.requires_key);
    }
    requires = Object.fromEntries(
      Object.entries(grouped).map(([key, groups]) => [key, Object.values(groups)])
    );
  }

  const selfServe = modules.filter((m) => m.self_serve).map((m) => m.key);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl text-stone-900">One more step</h1>
      <p className="mt-2 text-stone-600">
        Tell us about your business and we&apos;ll set it up with sensible defaults, or join one
        you&apos;ve been invited to.
      </p>
      <OnboardingForm presets={presets} modules={modules} requires={requires} selfServe={selfServe} />
    </main>
  );
}
