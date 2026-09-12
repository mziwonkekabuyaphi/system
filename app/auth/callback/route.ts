import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/app";
  const errorCode = searchParams.get("error_code");
  const errorDescription = searchParams.get("error_description");

  // Supabase redirects here with error params when a link is expired,
  // already used, or otherwise invalid — before any code exchange happens.
  if (errorCode) {
    const message =
      errorCode === "otp_expired"
        ? "That confirmation link has expired. Sign up again or request a new one."
        : (errorDescription?.replace(/\+/g, " ") ?? "That link is no longer valid.");

    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(message)}`
    );
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }

    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`
    );
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("Missing confirmation code.")}`
  );
}
