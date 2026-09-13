# Lift Tracker

Self-hosted weightlifting workout tracker. Runs entirely on your own
machine; data is saved to a JSON file on disk, not to any cloud service.
Access is gated behind Google Sign-In, restricted to an allowlist of
Google account emails you configure.

Start a workout, add exercises from the built-in library (or your own
custom ones), log weight/reps per set, finish the workout, and browse
past workouts in History.

## One-time setup: Google Sign-In

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   pick or create a project, then go to **APIs & Services > Credentials**.
2. Configure the **OAuth consent screen** if you haven't already (External
   user type is fine for personal use; add your own Google account under
   "Test users" if the app stays in Testing mode).
3. Click **Create Credentials > OAuth client ID**, application type
   **Web application**.
4. Under **Authorized JavaScript origins**, add:
   - `http://localhost:3000` (for local/dev use)
   - your Cloud Run service URL, if deploying there
   - No **Authorized redirect URIs** are needed.
5. Copy the generated **Client ID**.
6. Copy `.env.example` to `.env` and fill in:
   - `GOOGLE_CLIENT_ID` — the client ID from step 5
   - `AUTHORIZED_EMAILS` — comma-separated Google account emails allowed to
     sign in (each gets their own private workout log)
   - `DISPLAY_NAMES` — optional friendly names, see `.env.example` for the
     format
   - `SESSION_SECRET` — a random string, e.g. `openssl rand -hex 32`

`.env` is gitignored — never commit it.

## Run with Docker (recommended)

Requires Docker and Docker Compose.

```bash
cd lift-tracker
docker compose up --build
```

Then open **http://localhost:3000** in your browser and sign in with an
authorized Google account.

Your data is saved to `./data/storage.json` on your machine (created
automatically on first run). Stopping or rebuilding the container does
not lose data, since that folder is mounted into the container as a
volume. To stop it:

```bash
docker compose down
```

To run it in the background:

```bash
docker compose up --build -d
```

## Run without Docker

Requires Node.js 18+.

```bash
cd lift-tracker
npm install
```

Copy `.env.example` to `.env` (see setup above), then either load it into
your shell or run:

```bash
set -a && source .env && set +a && npm start
```

Since plain `http://localhost` isn't HTTPS, also set `COOKIE_SECURE=false`
in `.env` for local runs without Docker/a reverse proxy.

Open **http://localhost:3000**. Data saves to `./data/storage.json` in
this folder.

## Changing the port

Docker: edit the `ports` line in `docker-compose.yml` (left side is the
host port), e.g. `"8080:3000"` to use port 8080.

Without Docker: `PORT=8080 npm start`

## Data model

Everything is stored as simple key/value pairs per user in
`data/storage.json`:

- `custom_exercises` — exercises you've added beyond the built-in library
- `active_workout` — the in-progress workout, if any (survives reloads)
- `workout_<timestamp>` — one entry per finished workout

## Project layout

```
lift-tracker/
├── server.js            Express server + file-based storage API + Google auth
├── public/index.html    The tracker UI (single-page app)
├── public/login.html    Google Sign-In page
├── data/                 Created on first run - your saved data lives here
├── .env.example         Template for required environment variables
├── Dockerfile
├── docker-compose.yml
└── package.json
```
