"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./AuthForm.module.css";
import { PasswordInput } from "./PasswordInput";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(
        error.message === "Invalid login credentials"
          ? "That email and password don't match our records."
          : error.message
      );
      return;
    }

    // An explicit ?next= always wins (e.g. a bounced deep link). Otherwise a
    // salesperson goes to /sales and everyone else to /admin. Same rule as
    // requireSalesperson() in lib/sales/auth.ts: a salespeople row for this
    // user whose status is not "terminated". Best-effort: any failure here
    // just falls back to /admin, so sign-in is never blocked by this lookup.
    const explicitNext = searchParams.get("next");
    let destination = explicitNext || "/admin";

    if (!explicitNext) {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const { data: isAdmin } = await supabase.rpc("is_platform_admin");
          const { data: salesperson } = await supabase
            .from("salespeople")
            .select("id, status")
            .eq("profile_id", user.id)
            .maybeSingle();
          if (isAdmin) {
            destination = "/platform";
          } else if (salesperson && salesperson.status !== "terminated") {
            destination = "/sales";
          }
        }
      } catch {
        // keep the /admin default
      }
    }

    router.push(destination);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <div className={styles.field}>
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={!!error}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="password">Password</label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          invalid={!!error}
        />
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <button className={styles.submit} type="submit" disabled={loading}>
        {loading ? "Signing in…" : "Sign in"}
      </button>

      <p className={styles.footerLine}>
        New to ZozoQueue? <a href="/signup">Create an account</a>
      </p>
    </form>
  );
}
