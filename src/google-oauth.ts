import { slackUserMapping } from './db/schema/main'
import db from './db/engine'

export interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
}

/**
 * Exchange OAuth authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL}/auth/google/callback`,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code for tokens: ${error}`)
  }

  return response.json() as Promise<GoogleTokenResponse>
}

/**
 * Save Google tokens for a Slack user
 */
export async function saveUserTokens(
  slackUserId: string,
  slackTeamId: string,
  tokens: GoogleTokenResponse,
  slackUserName?: string,
  slackDisplayName?: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

  await db
    .insert(slackUserMapping)
    .values({
      slackUserId,
      slackTeamId,
      googleAccessToken: tokens.access_token,
      googleRefreshToken: tokens.refresh_token || null,
      googleTokenExpiresAt: expiresAt,
      slackUserName: slackUserName || null,
      slackDisplayName: slackDisplayName || null,
    })
    .onConflictDoUpdate({
      target: slackUserMapping.slackUserId,
      set: {
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token || null,
        googleTokenExpiresAt: expiresAt,
        slackUserName: slackUserName || null,
        slackDisplayName: slackDisplayName || null,
        linkedAt: new Date(),
      },
    })
}