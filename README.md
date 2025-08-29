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

Set the following env vars to their proper values (e.g. in your ~/.bashrc):
```
PV_DB_URL=...
PV_OPENROUTER_API_KEY=...
PV_GOOGLE_CLIENT_ID=...
PV_GOOGLE_CLIENT_SECRET=...
PV_LANGFUSE_PUBLIC_KEY=...
PV_LANGFUSE_SECRET_KEY=...
```

For the next part, you will have to have PostgreSQL installed, so first follow the installation instructions below if you don't have it installed already.

Run the flack server:
```
pnpm run local
```

You can then visit the flack website in your browser at http://localhost:5173. While the flack server is running, you can also run evals with:
```
pnpm run eval
```

To run the bot in production mode, you will additionally need the `PV_BASE_URL`, `PV_SLACK_BOT_TOKEN`, and `PV_SLACK_APP_TOKEN` env vars set. This will connect with real slack and avoid starting the dev-only website:
```
pnpm run prod
```

If you want to run the bot in production mode with live-reload (for example, when testing a local version of the code with the live "Pivotal Dev" slack bot), you can run:
```
pnpm run dev
```

## Setting Up Local DB

The installation instructions for PostgreSQL are different for MacOS and Linux.

### MacOS

Install and start postgres 16, then create pivotal DB:
```
brew install postgresql@16
brew services start postgresql@16
createdb pivotal

# probably also add the following to your ~/.bashrc
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

