import { Suspense } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "Sign in · QLess" };

export default function LoginPage() {
  return (
    <AuthShell
      ticketNumber="014"
      tagline="Every business you manage, one held place in line."
      heading="Sign in"
      subheading="Welcome back. Enter your details to get to your queue."
    >
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
