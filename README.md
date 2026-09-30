# npm Public Email Collector

Chrome extension plus a TypeScript backend for reviewing public npm email addresses and sending one-to-one Gmail messages after an explicit confirmation.

Discovery still searches the public npm registry. Finding an address does not send mail. The extension syncs contacts to the API, the API marks each address `NEW`, `ALREADY_CONTACTED`, `SUPPRESSED`, or `INVALID`, and only addresses you queue from a campaign are emailed.

```
Chrome extension
    -> Backend REST API
        -> SQLite
        -> send queue stored in SQLite (gmail-send)
        -> Gmail OAuth 2.0
        -> Gmail API users.messages.send
        -> one recipient
```

The extension never stores a Gmail password or an OAuth refresh token.

## Layout

- `extension/` Manifest V3 collector and outreach UI. Load `extension/build` after `npm run build`.
- `backend/` Fastify API, Prisma, SQLite, and a file-backed send worker.
- `shared/` email normalization, template rendering, and shared status types.

## 1. SQLite

The API stores contacts, campaigns, and the send queue in a local SQLite file. No PostgreSQL server and no Redis process are required. Prisma creates the file during migration.

## 2. DATABASE_URL

```bash
cd backend
npm install
```

`npm install` creates `backend/.env` from `.env.example` when that file is missing. On Windows, do not copy `.env` by hand unless install did not create it:

```bat
copy .env.example .env
```

If `backend/.env` already exists from an earlier PostgreSQL setup, replace the database line with:

```
DATABASE_URL="file:./dev.db"
```

That path is relative to `backend/prisma/`. The file is `backend/prisma/dev.db`. Do not commit `.env` or the database file.

## 3. Prisma migration

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev
```

`npm install` links `shared/` with a Node script, including on Windows. `migrate dev` reads `DATABASE_URL` from `backend/.env` and creates the SQLite file. On a machine that already has the migration and only needs to apply it, use:

```bash
npx prisma migrate deploy
```

## 4. Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project, for example `npm-outreach-dev`.
3. Leave it in testing mode while you are the only sender.

## 5. Enable the Gmail API

APIs & Services → Library → search **Gmail API** → Enable.

## 6. OAuth consent screen

APIs & Services → OAuth consent screen.

- User type: External (or Internal for a Workspace org).
- App name: npm Public Email Collector.
- Add your Google account as a **test user** while the app is unverified.
- Scopes: `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`.

`gmail.send` is the only Gmail scope. The app does not request read, modify, or full mailbox access. `email` / `openid` are only used to display the connected address.

## 7. OAuth redirect URL

APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.

Authorized redirect URI:

```
http://localhost:3000/api/auth/google/callback
```

Production must be the public API origin plus `/api/auth/google/callback`. Put the same value in `GOOGLE_REDIRECT_URI`.

## 8. Environment variables

`backend/.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file URL. Local default: `file:./dev.db` |
| `PORT` | API port, default `3000` |
| `BACKEND_API_KEY` | Bearer token the extension sends. Use a long random string. |
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Callback URL from step 7 |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for refresh tokens. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `EMAIL_SEND_INTERVAL_MS` | Minimum delay between successful sends. Default `10000`. |
| `MAX_EMAILS_PER_HOUR` | Application cap. Default `50`. Lower this if you want. Do not raise it to evade Gmail. |
| `MAX_EMAILS_PER_DAY` | Application cap. Default `200`. |
| `APP_BASE_URL` | Public API origin used in unsubscribe links, such as `http://localhost:3000`. |
| `EXTENSION_ORIGIN` | Exact `chrome-extension://<id>` origin. Leave empty in local unpacked development to allow any extension origin. |
| `ALLOW_REPEAT_CONTACT` | Must stay `false`. The extension cannot override it. |
| `INCLUDE_UNSUBSCRIBE_LINK` | Appends an unsubscribe link when `APP_BASE_URL` is set. |
| `RUN_WORKER_IN_SERVER` | `false` in production so the worker is a separate process. |

`BACKEND_API_KEY` is a single-user development secret. A production deployment should replace it with real user authentication instead of shipping one permanent shared key inside the extension.

## 9. Backend startup

Terminal 1:

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Health check: `GET http://localhost:3000/api/health` returns `{ "ok": true }`.

## 10. Worker startup

Terminal 2:

```bash
cd backend
npm run worker
```

The worker polls the `SendJob` table in the same SQLite file. The API can boot without the worker; queued jobs wait until the worker is running. Set `RUN_WORKER_IN_SERVER=true` only when you want one process to do both during local development. Run the API and the worker on the same machine so both can open `dev.db`.

## 11. Chrome extension installation

```bash
cd extension
npm install
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Choose `extension/build` (not the `extension/` source folder).

The toolbar icon opens the collector. `npm run watch` rebuilds scripts while you edit.

## 12. Backend URL configuration

Extension toolbar → the collector → **Settings**, or right-click the extension → Options.

- Backend URL: `http://localhost:3000`
- API key: the same value as `BACKEND_API_KEY`
- **Test connection**

Success shows `Connected`. A refused key shows that the server is up but the key was rejected. A network failure shows the browser error.

## 13. Gmail connection

Open the **Gmail** tab → **Connect Gmail**.

The extension asks the API for the Google consent URL and opens it. After you approve, the callback stores an encrypted refresh token and the tab tells you to return to the extension. Focus the collector again. The Gmail tab should show `Connected` and the mailbox address. It never shows a token.

**Disconnect** deactivates the account and deletes the stored refresh token.

## 14. Test contact collection

1. **Discovery** → **Test npm connection**. The activity log should say `Connection OK`.
2. Keywords: `react`
3. Target: `100`
4. Maximum packages: `500`
5. Delay: `400 ms`
6. **Start new collection**

The table keeps the original columns and adds a status badge. After each batch the extension calls `POST /api/contacts/ingest`. The activity log reports counts such as:

```
[12:31:20] Synced 82 contacts.
[12:31:21] 53 new eligible.
[12:31:21] 21 already contacted.
[12:31:21] 8 suppressed.
```

If the API is offline, rows stay in the table as `SYNCING` and in `chrome.storage.local` under `pendingBackendSync`. They are retried while the collector is open and about once a minute by the service worker. Collected npm results are not deleted when sync fails.

## 15. Campaign creation

**Campaigns** → name, subject, and body. Tokens:

- `{{name}}`
- `{{firstName}}`
- `{{email}}`
- `{{package}}`
- `{{packageUrl}}`

Empty `{{firstName}}` renders a greeting as `Hi,` rather than `Hi undefined,`. Unknown tokens are refused before send.

**Save draft**, then on **Contacts** select rows or **Select all new**.

## 16. Send queue test

1. Connect Gmail and start the worker.
2. Click **Queue campaign**.
3. Read the counts: selected, previously contacted, suppressed, invalid, eligible.
4. Confirm **Queue N recipients**.

The worker sends one Gmail API message per recipient, records the Gmail message id, sets the contact to `CONTACTED`, and adds an `ALREADY_CONTACTED` suppression. Pause finishes the message already in flight and does not start another until **Resume**. Cancel marks unsent recipients `CANCELLED`.

Application limits (`EMAIL_SEND_INTERVAL_MS`, `MAX_EMAILS_PER_HOUR`, `MAX_EMAILS_PER_DAY`) delay jobs. They are not a way around Gmail's own limits. Each recipient is a separate `users.messages.send` call. There is no BCC blast.

Transient Gmail failures (`429`, `500`, `502`, `503`, `504`, network timeout) retry at 30 seconds and then 2 minutes. The third failure is permanent. Permanent errors such as `400` are `FAILED` immediately.

## 17. Duplicate prevention test

1. Queue and send `john@example.com`.
2. Run another npm search that discovers the same address.
3. The badge is `CONTACTED`.
4. Selecting that contact for a new campaign reports it under previously contacted. It is not queued.

`ALLOW_REPEAT_CONTACT` defaults to `false` and is read only on the server. The extension has no control that overrides it.

Unsubscribe links look like `APP_BASE_URL/unsubscribe/<random token>`. The token is not a database id. Opening it suppresses the address with reason `UNSUBSCRIBED`.

## Scripts

Backend:

```bash
npm run dev
npm run build
npm start
npm run worker
npm run prisma:generate
npm run prisma:migrate
npm run lint
npm run typecheck
npm test
```

Extension:

```bash
npm run build
npm run watch
npm run lint
npm run typecheck
```

## API

Authenticated routes expect `Authorization: Bearer <BACKEND_API_KEY>`.

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/health` | Public |
| GET | `/api/auth/google` | Bearer. Returns `{ url }` when `Accept` contains `application/json`. |
| GET | `/api/auth/google/callback` | Public OAuth redirect |
| GET | `/api/gmail/account` | Bearer. Never returns a token. |
| POST | `/api/gmail/disconnect` | Bearer |
| POST | `/api/contacts/ingest` | Bearer |
| GET | `/api/contacts` | Bearer. `status`, `search`, `page`, `limit`, `contacted`, `suppressed`. |
| GET | `/api/contacts/stats` | Bearer |
| POST | `/api/campaigns` | Bearer |
| GET | `/api/campaigns` | Bearer |
| GET | `/api/campaigns/:id` | Bearer |
| PATCH | `/api/campaigns/:id` | Bearer. Drafts only. |
| DELETE | `/api/campaigns/:id` | Bearer. Drafts only. |
| POST | `/api/campaigns/:id/recipients` | Bearer. `contactIds` and/or `filter`. |
| POST | `/api/campaigns/:id/queue` | Bearer |
| POST | `/api/campaigns/:id/start` | Bearer |
| POST | `/api/campaigns/:id/pause` | Bearer |
| POST | `/api/campaigns/:id/resume` | Bearer |
| POST | `/api/campaigns/:id/cancel` | Bearer |
| GET | `/api/suppressions` | Bearer |
| POST | `/api/suppressions` | Bearer |
| DELETE | `/api/suppressions/:id` | Bearer |
| GET | `/api/history` | Bearer |
| GET | `/unsubscribe/:token` | Public confirmation page |

Errors:

```json
{ "error": { "code": "GMAIL_NOT_CONNECTED", "message": "...", "details": {} } }
```

Sensitive routes are rate limited.

## What the tests cover

`cd backend && npm test` checks:

- one contact when the same email is discovered twice
- one contact and two sources for two packages
- a previously sent contact cannot join another campaign
- a suppressed contact cannot be queued
- queueing twice does not duplicate recipients
- the same worker job sends at most once
- noreply addresses are rejected
- email normalization
- a paused campaign does not start a send
- transient Gmail failures retry
- three transient failures, or one permanent failure, stop
- a successful send updates the recipient, contact, audit log, and suppression list

## Known limitations

- One active Gmail account. This is a single-operator tool.
- API authentication is a shared bearer key. Replace it before any multi-user deployment.
- Unpacked extension ids change when the folder changes. Leave `EXTENSION_ORIGIN` empty locally, and pin the real origin in production.
- Google may require app verification before non-test users can grant `gmail.send`.
- Send caps are application safety limits. Gmail can still reject mail under its own policies.
- Retry spacing is 30 seconds after the first failure and 2 minutes after the second. The third attempt is the last one.
- If Gmail accepts a message and the database update fails, the worker writes a `SendReconciliation` row and a later job finalizes that row instead of sending again.
- The database is a local SQLite file. The API and worker must run on the same computer and use the same `DATABASE_URL`.
- Run one worker. SQLite does not provide the row locks PostgreSQL used for concurrent senders.
- The contacts "Suppressed" filter includes every suppression row, including addresses suppressed because they were already contacted. Those still display as contacted in discovery.
- Node.js 20 is the comfortable target. The project typechecks and tests on Node 18.19; some transitive packages warn that they prefer Node 20.
