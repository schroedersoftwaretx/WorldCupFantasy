# Firebase setup

The web app uses **Firebase Authentication** for Google sign-in (phase W2).
Sign-in will not work until you create a Firebase project and copy seven
values into your `.env` file. This guide walks through every step. It takes
about ten minutes and is a one-time setup.

By the end you will have filled in these `.env` keys:

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

The first four (`NEXT_PUBLIC_*`) are the **client config** — they are sent to
the browser and are not secret. The last three are the **service account** —
they are secret, stay on the server, and must never be committed.

---

## Step 1 — Create a Firebase project

1. Go to <https://console.firebase.google.com> and sign in with a Google
   account.
2. Click **Create a project** (or **Add project**).
3. Give it a name, e.g. `worldcup-fantasy`. Accept the default project ID or
   set your own.
4. Google Analytics is not needed — you can turn it off.
5. Click **Create project** and wait for it to finish.

## Step 2 — Enable Google sign-in

1. In the project, open **Build → Authentication** in the left sidebar.
2. Click **Get started**.
3. On the **Sign-in method** tab, select **Google** from the provider list.
4. Toggle it **Enable**, choose a support email, and click **Save**.

That is the only provider the app uses.

## Step 3 — Register a Web app (the client config)

1. Open **Project settings** (the gear icon, top-left, next to *Project
   Overview*).
2. Scroll to **Your apps** and click the **Web** icon (`</>`).
3. Give the app a nickname, e.g. `worldcup-fantasy-web`. You do **not** need
   Firebase Hosting. Click **Register app**.
4. Firebase shows a `firebaseConfig` object. Copy these four values:

   | `firebaseConfig` field | `.env` key |
   |---|---|
   | `apiKey` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
   | `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
   | `projectId` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
   | `appId` | `NEXT_PUBLIC_FIREBASE_APP_ID` |

   (`storageBucket` and `messagingSenderId` are not used.)

You can always find this again under **Project settings → General → Your apps
→ SDK setup and configuration**.

## Step 4 — Generate a service account key (the server credentials)

1. Still in **Project settings**, open the **Service accounts** tab.
2. Click **Generate new private key**, then **Generate key** to confirm.
3. A JSON file downloads. Open it — it contains, among other fields:

   | JSON field | `.env` key |
   |---|---|
   | `project_id` | `FIREBASE_PROJECT_ID` |
   | `client_email` | `FIREBASE_CLIENT_EMAIL` |
   | `private_key` | `FIREBASE_PRIVATE_KEY` |

**Treat this file as a password.** It grants admin access to your Firebase
project. Do not commit it and do not share it. Once the three values are in
`.env` you can delete the downloaded file.

## Step 5 — Fill in `.env`

If you have not already, copy the template: `cp .env.example .env`. Then set
the seven values.

The first six are straightforward copy-paste. The **private key needs care**
because it contains newlines. In the downloaded JSON it looks like one long
string with literal `\n` sequences:

```
"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

Copy it into `.env` **with the surrounding double quotes and the `\n`
sequences kept exactly as-is**:

```
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

The app converts the `\n` sequences back into real newlines at startup. A
finished `.env` block looks like:

```
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyD...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=worldcup-fantasy.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=worldcup-fantasy
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:abcdef123456
FIREBASE_PROJECT_ID=worldcup-fantasy
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@worldcup-fantasy.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

## Step 6 — Authorized domains

Firebase only allows sign-in from domains on an allow-list. **`localhost` is
on it by default**, so local development works immediately. When the app is
deployed (phase W6), come back to **Authentication → Settings → Authorized
domains** and add the production domain.

## Step 7 — Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. You should be redirected to `/login`, see a
**Sign in with Google** button, and after signing in land back on the leagues
page with your name in the header.

The first time you sign in, the app automatically creates your `manager` row,
keyed to your Firebase user id — there is no separate registration step.

---

## Troubleshooting

**The login page says "Firebase is not configured yet."**
The four `NEXT_PUBLIC_FIREBASE_*` values are missing or incomplete in `.env`.
Note that `NEXT_PUBLIC_*` values are read at build time — restart `npm run
dev` after editing `.env`.

**Sign-in popup opens but fails with `auth/unauthorized-domain`.**
The domain you are visiting is not on the authorized list (Step 6). For local
work make sure you are on `http://localhost:3000`, not a `127.0.0.1` address.

**Server logs show "Firebase Admin is not configured" or a credential error.**
One of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
is missing or malformed. The most common cause is the private key: it must be
wrapped in double quotes and keep its `\n` sequences (Step 5).

**The popup is blocked.**
Allow popups for `localhost` in your browser, or try the sign-in button
again — the first click sometimes needs the popup permission prompt first.
