import { Suspense } from "react";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata = { title: "Create account · QLess" };

export default function SignupPage() {
  return (
    <AuthShell
      ticketNumber="001"
      tagline="Take your first number. Set up sign-in for your team in minutes."
      heading="Create your account"
      subheading="Start with your own sign-in — you can create or join a business next."
    >
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}
