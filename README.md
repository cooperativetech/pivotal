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

Install `mkcert`, and use it to create a locally trusted CA certificate, which allows us to run our local server using https. This is necessary to authenticate with slack, which requires https for its redirect URLs.
```
brew install mkcert
brew install nss  # if you use Firefox
mkcert -install
pnpm run cert
```

Set the following env vars to their proper values (e.g. in your ~/.bashrc):
```
export PV_DB_URL=...
export PV_OPENROUTER_API_KEY=...
export PV_SLACK_CLIENT_ID=...
export PV_SLACK_CLIENT_SECRET=...
export PV_GOOGLE_CLIENT_ID=...
export PV_GOOGLE_CLIENT_SECRET=...
export PV_LANGFUSE_BASE_URL=...
export PV_LANGFUSE_PUBLIC_KEY=...
export PV_LANGFUSE_SECRET_KEY=...
```

For the next part, you will have to have PostgreSQL installed, so first follow the installation instructions below if you don't have it installed already.

Run the flack server:
```
pnpm run local
```

You can then visit the website in your browser at https://localhost:5173. While the local server is running, you can also run evals with:
```
pnpm run eval
```

To run the bot in dev mode, for testing a local version of the code with the live "Pivotal Dev" slack bot, you will additionally need the `PV_SLACK_BOT_TOKEN` and `PV_SLACK_APP_TOKEN` env vars set. This will connect with real slack and avoid exposing the local-only website routes:
```
pnpm run dev
```

You can then visit the website in your browser at https://localhost:3009. This hosts the "production" version of the website, with rolled-up js and css assets served out of the src/dist folder.

To run the bot in production, you additionally need `PV_BETTER_AUTH_SECRET` set to a random string, and `PV_BASE_URL` set to the public website's URL. Then, run:
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

