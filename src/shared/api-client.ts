import { hc } from 'hono/client'
import { createAuthClient } from 'better-auth/client'
import type { BetterAuthClientPlugin } from 'better-auth/client'
import type { AppType } from '../server'
import type { githubAppInstallationPlugin } from '../auth'

// Use relative URL when running frontend code
// Use direct URL to local server when running outside frontend code (e.g. in evals)
const isFrontend = import.meta.env ?? false
const apiBaseURL = isFrontend ? '/' : 'http://localhost:3001'

// Hono API client
const appType = hc<AppType>(apiBaseURL)
export const { api, local_api } = appType

// Better Auth client

function githubAppInstallationPluginClient() {
  return {
    id: 'github-app-installation',
    $InferServerPlugin: {} as ReturnType<typeof githubAppInstallationPlugin>,
    pathMethods: {
      '/github-app/init-install': 'POST',
    },
  } satisfies BetterAuthClientPlugin
}

export const authClient = createAuthClient({
  plugins: [
    githubAppInstallationPluginClient(),
  ],
})
