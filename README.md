## Getting Started

Ensure you're using the correct version of node (from .nvmrc):
```
brew install nvm
nvm use
```

Install dependencies with pnpm:
```
brew install pnpm
pnpm install
```

`pnpm install` also downloads the Playwright Chromium bundle used by the Meet co-host automation. Re-run `pnpm exec playwright install chromium` manually if you ever need to refresh the browser binaries.

Install `mkcert`, and use it to create a locally trusted CA certificate, which allows us to run our local server using https. This is necessary to authenticate with slack, which requires https for its redirect URLs.
```
brew install mkcert
brew install nss  # if you use Firefox
mkcert -install
pnpm run cert
```

For linux,
```
sudo apt install mkcert
mkcert -install
pnpm run cert
```

If running on WSL, you also need to trust this in the Windows partition. First, copy the files (which are generated in ```pivotal/.cert```) over to the Windows partition. Then, double-click to open the certification, and install it to ```Trusted Root Certification Authorities```.

Set the following env vars to their proper values (e.g. in your `~/.zshrc` or `~/.bashrc`). Note: the app and tooling do not load a `.env` file automatically.

```
export PV_DB_URL=...
export PV_OPENROUTER_API_KEY=...
export PV_BETTER_AUTH_SECRET=...
export PV_SLACK_CLIENT_ID=...
export PV_SLACK_CLIENT_SECRET=...
export PV_GITHUB_APP_NAME=...
export PV_GITHUB_CLIENT_ID=...
export PV_GITHUB_CLIENT_SECRET=...
export PV_GITHUB_BOT_USERNAME=...
export PV_GITHUB_BOT_ACCESS_TOKEN=...
export PV_GOOGLE_CLIENT_ID=...
export PV_GOOGLE_CLIENT_SECRET=...
export PV_LANGFUSE_BASE_URL=...
export PV_LANGFUSE_PUBLIC_KEY=...
export PV_LANGFUSE_SECRET_KEY=...
export PV_GOOGLE_ORGANIZER_EMAIL=...
export PV_GOOGLE_ORGANIZER_PASSWORD=...
```

Optional overrides for the Playwright automation:

```
export PV_BROWSERLESS_WS_ENDPOINT=...
export PV_BROWSERLESS_API_TOKEN=...
export PV_BROWSERLESS_FORCE_LOCAL=false
export PV_PLAYWRIGHT_HEADLESS=false
```

Leave the Browserless variables unset to run Chromium locally (default). Set `PV_BROWSERLESS_FORCE_LOCAL=false` when you want to connect to a Browserless endpoint instead. Toggle `PV_PLAYWRIGHT_HEADLESS=false` to watch the automation while debugging.

For the next part, you will have to have PostgreSQL database running, so first follow the "Setting Up Local DB" instructions below if you don't have it installed already.

Run the flack server:
```
pnpm run local
```

You can then visit the website in your browser at https://localhost:5173. While the local server is running, you can also run evals with:
```
pnpm run eval
```

The eval command supports several options:
```
pnpm run eval --help                          # Show all options
pnpm run eval -f benchmark_file.json          # Run specific benchmark file
pnpm run eval -d benchmark_folder             # Run all files in folder
pnpm run eval -r 5                            # Run 5 repetitions per case
pnpm run eval --topicRouting                  # Enable topic routing (flag only, default: false)
```


To run the bot in dev mode, for testing a local version of the code with the live "Pivotal Dev" slack bot, you will additionally need the `PV_SLACK_APP_TOKEN` env var set. This will connect with real slack and avoid exposing the local-only website routes:
```
pnpm run dev
```

You can then visit the website in your browser at https://localhost:3009. This hosts the "production" version of the website, with rolled-up js and css assets served out of the src/dist folder.

To run the bot in production, you additionally need `PV_BASE_URL` set to the public website's URL. Then, run:
```
pnpm run prod
```

## Setting Up Local DB

The installation instructions for PostgreSQL are different for MacOS and Linux.

### MacOS

Install and start postgres 16, then create pivotal DB:
```
brew install postgresql@16
brew services start postgresql@16
createdb pivotal

# add the following to your shell init (e.g., `~/.zshrc` or `~/.bashrc`)
export PV_DB_URL='postgresql://localhost:5432/pivotal'
```

Run drizzle-kit migrations (`PV_DB_URL` env var must be set):
```
pnpm run dkmig
```

If you change `db/schema.ts`, you can use drizzle-kit to automatically generate and run corresponding migrations:
```
pnpm run dkgen
pnpm run dkmig
```

### Calendar Invites

- When a time is finalized, the bot uses the Google service account configured via `PV_GOOGLE_SERVICE_ACCOUNT_EMAIL`, `PV_GOOGLE_SERVICE_ACCOUNT_KEY`, and `PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT` to create a calendar event, adds topic users with emails as attendees, includes a Google Meet link, and posts the links in Slack. Implementation: see `createCalendarInviteFromBot` in `src/calendar-service.ts` and its trigger in `processSchedulingActions` in `src/slack-message-handler.ts`.

### Google Meet Co-host Automation

- Bot promotes attendees to Meet co-hosts using the Google account defined by `PV_GOOGLE_ORGANIZER_EMAIL` and `PV_GOOGLE_ORGANIZER_PASSWORD`; the account must be able to edit the event and should use an app password if 2FA is enabled.
- Ensure Playwright's Chromium bundle is installed (downloaded automatically during `pnpm install`; rerun `pnpm exec playwright install chromium` if needed). Set `PV_PLAYWRIGHT_HEADLESS=false` to watch the automation locally during debugging.
- Leave the organizer variables unset to skip the automation; calendar invites still send without automatic co-host changes.
- To run through Browserless, set `PV_BROWSERLESS_FORCE_LOCAL=false` and provide `PV_BROWSERLESS_WS_ENDPOINT` plus (optionally) `PV_BROWSERLESS_API_TOKEN`; the `PLAYWRIGHT_FORCE_LOCAL` and `BROWSERLESS_*` aliases are also honored.
- Browser state is cached in `/tmp/playwright-chrome-data` and debug screenshots are written to `/tmp/meet-debug-*.png` for troubleshooting.

### Linux

Follow Steps 1-3 of the installation instructions for PostgreSQL 16 listed on this page: https://neon.com/postgresql/postgresql-getting-started/install-postgresql-linux
Alternate, possibly simpler, instructions: https://help.ubuntu.com/community/PostgreSQL

Next, create a database user that has the same username as yours:

```
sudo -u postgres createuser --superuser $USER
```

Don't create a password for this user. If a password is set, set it null by accessing the postgres console and setting it to null:

```
postgres psql
ALTER USER <username> PASSWORD NULL;
```

Finally, you may need to edit the configuration file `pg_hba.conf` to ensure that users don't need passwords. Find the file (usually in `/etc/postgresql/16/main/pg_hba.conf`):

`sudo find /etc -name pg_hba.conf 2>/dev/null`

Edit it:

`sudo nano /etc/postgresql/16/main/pg_hba.conf`

Look for lines like:

`local all all peer host all all 127.0.0.1/32 scram-sha-256`
`host all all 127.0.0.1/32 scram-sha-256`

Change the authentication method from `scram-sha-256` to `trust` for local connections:

`host all all 127.0.0.1/32 trust`

Restart PostgreSQL:

`sudo systemctl restart postgresql`

The remaining steps are the same as for MacOS.

You probably also add the following to your ~/.bashrc

```
export PV_DB_URL='postgresql://localhost:5432/pivotal'
```

Run drizzle-kit migrations (`PV_DB_URL` env var must be set):
```
pnpm run dkmig
```

If you change `db/schema.ts`, you can use drizzle-kit to automatically generate and run corresponding migrations:
```
pnpm run dkgen
pnpm run dkmig
```

### Linux

Follow Steps 1-3 of the installation instructions for PostgreSQL 16 listed on this page: https://neon.com/postgresql/postgresql-getting-started/install-postgresql-linux
Alternate, possibly simpler, instructions: https://help.ubuntu.com/community/PostgreSQL

Next, create a database user that has the same username as yours:

```
sudo -u postgres createuser --superuser $USER
```

Don't create a password for this user. If a password is set, set it null by accessing the postgres console and setting it to null:

```
postgres psql
ALTER USER <username> PASSWORD NULL;
```

Finally, you may need to edit the configuration file `pg_hba.conf` to ensure that users don't need passwords. Find the file (usually in `/etc/postgresql/16/main/pg_hba.conf`):

`sudo find /etc -name pg_hba.conf 2>/dev/null`

Edit it:

`sudo nano /etc/postgresql/16/main/pg_hba.conf`

Look for lines like:

`local all all peer host all all 127.0.0.1/32 scram-sha-256`
`host all all 127.0.0.1/32 scram-sha-256`

Change the authentication method from `scram-sha-256` to `trust` for local connections:

`host all all 127.0.0.1/32 trust`

Restart PostgreSQL:

`sudo systemctl restart postgresql`

The remaining steps are the same as for MacOS.

You probably also add the following to your ~/.bashrc

```
export PV_DB_URL='postgresql://localhost:5432/pivotal'
```

Run drizzle-kit migrations (`PV_DB_URL` env var must be set):
```
pnpm run dkmig
```

If you change `db/schema.ts`, you can use drizzle-kit to automatically generate and run corresponding migrations:
```
pnpm run dkgen
pnpm run dkmig
```
