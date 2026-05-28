/**
 * Firebase Admin SDK initialization (server-only).
 *
 * Used to verify Firebase ID tokens and to mint / verify session cookies.
 * Credentials come from a service account, supplied through three env vars
 * (see FIREBASE_SETUP.md). The app is memoized on globalThis so Next.js dev
 * hot-reloads do not re-initialize it - firebase-admin throws on a duplicate
 * default-app init.
 */
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

const globalForAdmin = globalThis as unknown as { __wcAdminApp?: App };

/** True when all three service-account env vars are present. */
export function isAdminConfigured(): boolean {
  return Boolean(
    process.env["FIREBASE_PROJECT_ID"] &&
      process.env["FIREBASE_CLIENT_EMAIL"] &&
      process.env["FIREBASE_PRIVATE_KEY"],
  );
}

function getAdminApp(): App {
  if (globalForAdmin.__wcAdminApp) return globalForAdmin.__wcAdminApp;

  const existing = getApps()[0];
  if (existing) {
    globalForAdmin.__wcAdminApp = existing;
    return existing;
  }

  const projectId = process.env["FIREBASE_PROJECT_ID"];
  const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"];
  const privateKeyRaw = process.env["FIREBASE_PRIVATE_KEY"];
  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error(
      "Firebase Admin is not configured - set FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY (see FIREBASE_SETUP.md)",
    );
  }
  // .env stores the PEM key with literal \n escapes; restore real newlines.
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  globalForAdmin.__wcAdminApp = app;
  return app;
}

/** The Admin Auth service. Throws if Firebase Admin is not configured. */
export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}
