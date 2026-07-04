import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionProfile } from "../lib/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Already signed in → straight to the account page.
  if (await getSessionProfile()) {
    redirect("/account");
  }
  return (
    <div className="mx-auto max-w-sm px-5 sm:px-8">
      <section className="pt-16 pb-8">
        <p className="type-kicker">Welcome back</p>
        <h1 className="type-display mt-3 text-3xl text-text-primary">Sign in</h1>
        <p className="mt-3 text-sm text-text-secondary">
          Use the email and password from your invitation.
        </p>
      </section>
      <LoginForm />
    </div>
  );
}
