/**
 * Notification preferences page.
 *
 * A thin Server Component: auth-gate, load the manager's preference matrix and
 * the category metadata, then hand off to the <NotificationSettings> client
 * component for the toggles.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import {
  CATEGORY_LABELS,
  NOTIFICATION_CATEGORIES,
  getPreferences,
} from "@/data/notify/preferences";

import NotificationSettings from "./notification-settings";

export const dynamic = "force-dynamic";

export default async function NotificationPreferencesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const preferences = await getPreferences(getDb(), user.manager.id);
  const categories = NOTIFICATION_CATEGORIES.map((key) => ({
    key,
    label: CATEGORY_LABELS[key].label,
    description: CATEGORY_LABELS[key].description,
  }));
  const channels = [
    { key: "IN_APP" as const, label: "In-app" },
    { key: "EMAIL" as const, label: "Email" },
  ];

  return (
    <>
      <Link href="/" className="back-link">
        &larr; Your leagues
      </Link>
      <h1>Notification preferences</h1>
      <NotificationSettings
        initial={preferences}
        categories={categories}
        channels={channels}
      />
    </>
  );
}
