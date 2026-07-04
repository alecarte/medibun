import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PatientProfileCard } from "../components/patient-profile-card";
import { getSessionProfile } from "../lib/session";
import { LogoutButton } from "./logout-button";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const profile = await getSessionProfile();
  if (!profile) {
    redirect("/login");
  }
  return (
    <div className="mx-auto max-w-2xl px-5 sm:px-8">
      <section className="pt-12 pb-8">
        <p className="type-kicker">Your account</p>
        <h1 className="type-display mt-3 text-3xl text-text-primary">
          Good to see you, {profile.name.split(" ")[0]}.
        </h1>
      </section>
      <PatientProfileCard profile={profile} />
      <div className="mt-8">
        <LogoutButton />
      </div>
    </div>
  );
}
