import { redirect } from "next/navigation";

/**
 * The staff app's home. For now it lands on the Schedule; this route becomes the
 * "Today" staff dashboard (events, recommended follow-ups, radar items) when that
 * surface is designed — direction recorded at the S5a review (V0_PROPOSAL §10).
 */
export default function Home() {
  redirect("/schedule");
}
