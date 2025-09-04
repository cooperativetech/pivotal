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

## Ngrok

- Problem: Slack OAuth requires HTTPS callback URLs, but our local
development runs on http://localhost:5173
- Solution: Ngrok creates an HTTPS tunnel (e.g.,
https://015231acd470.ngrok-free.app) that forwards to localhost
- Implementation: Modified CORS settings, auth client, and proxy
configuration to work with ngrok URLs

Setup

1. Install ngrok (for mac):
```brew install ngrok
```
# Or download from https://ngrok.com/download
You'll also have to make a free account and pass your api key from the website. 

2. Get ngrok tunnel (in separate terminal):
ngrok http 3001
2. This will show you an HTTPS URL. 
3. Update configuration:
- Replace 015231acd470.ngrok-free.app with your ngrok URL in:
    - export PV_BASE_URL=`your_new_ngrok_url`
- Add your ngrok URL to Slack api's trusted domains @ https://api.slack.com/apps/A0989PZDEJX/oauth?, under banner `Redirect URLs`.
4. Run the app:
pnpm run local    # Starts both server and frontend

Current Architecture (Temporary)

- Frontend: http://localhost:5173 (Vite dev server)
- API proxy: /api routes to ngrok HTTPS URL
- Direct backend: http://localhost:3001 (for flack testing)

Note: This entire workflow is temporary until we switch to the coopt.tech production domain. Then we'll have a stable domain + delete this stuff.