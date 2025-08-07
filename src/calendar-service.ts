import db from './db/engine'
import { slackUserMapping, userContext } from './db/schema/main'
import { eq } from 'drizzle-orm'

export interface CalendarConnectionStatus {
  slackUserId: string
  isConnected: boolean
  hasValidToken?: boolean
  needsReauth?: boolean
}

/**
 * Check calendar connection status for multiple Slack users
 * Returns array indicating which users are connected to Google Calendar
 */
export async function checkCalendarConnections(slackUserIds: string[]): Promise<CalendarConnectionStatus[]> {
  const results: CalendarConnectionStatus[] = []

  for (const slackUserId of slackUserIds) {
    try {
      const userMapping = await db
        .select()
        .from(slackUserMapping)
        .where(eq(slackUserMapping.slackUserId, slackUserId))
        .limit(1)

      if (userMapping.length === 0) {
        // User not found in mapping table - not connected
        results.push({
          slackUserId,
          isConnected: false,
        })
        continue
      }

      const mapping = userMapping[0]

      // Check if user has Google tokens
      if (!mapping.googleAccessToken || !mapping.googleRefreshToken) {
        results.push({
          slackUserId,
          isConnected: false,
        })
        continue
      }

      // Check if token is expired (with 5 minute buffer)
      const now = new Date()
      const bufferTime = 5 * 60 * 1000 // 5 minutes in milliseconds
      const isTokenExpired = mapping.googleTokenExpiresAt
        ? new Date(mapping.googleTokenExpiresAt).getTime() < (now.getTime() + bufferTime)
        : false

      results.push({
        slackUserId,
        isConnected: true,
        hasValidToken: !isTokenExpired,
        needsReauth: isTokenExpired,
      })

    } catch (error) {
      console.error(`Error checking calendar connection for user ${slackUserId}:`, error)
      results.push({
        slackUserId,
        isConnected: false,
      })
    }
  }

  return results
}

/**
 * Get list of Slack user IDs that don't have valid calendar connections
 * Used by scheduling workflow to determine who needs to authenticate
 */
export async function getUnconnectedUsers(slackUserIds: string[]): Promise<string[]> {
  const connectionStatuses = await checkCalendarConnections(slackUserIds)
  return connectionStatuses
    .filter(status => !status.isConnected || status.needsReauth)
    .map(status => status.slackUserId)
}

/**
 * Get or create user context for a Slack user
 * Returns existing context or creates empty context if none exists
 */
export async function getOrCreateUserContext(slackUserId: string): Promise<Record<string, any>> {
  try {
    const existingContext = await db
      .select()
      .from(userContext)
      .where(eq(userContext.slackUserId, slackUserId))
      .limit(1)

    if (existingContext.length > 0) {
      return existingContext[0].context as Record<string, any>
    }

    // Create new context entry
    await db
      .insert(userContext)
      .values({
        slackUserId,
        context: {},
      })
      .onConflictDoNothing()

    return {}
  } catch (error) {
    console.error(`Error getting/creating user context for ${slackUserId}:`, error)
    return {}
  }
}

/**
 * Update user context with new information learned by the LLM
 * Merges new context with existing context
 */
export async function updateUserContext(
  slackUserId: string,
  newContext: Record<string, any>,
): Promise<void> {
  try {
    // Get existing context first
    const existingContext = await getOrCreateUserContext(slackUserId)

    // Merge new context with existing
    const mergedContext = { ...existingContext, ...newContext }

    // Update in database
    await db
      .insert(userContext)
      .values({
        slackUserId,
        context: mergedContext,
      })
      .onConflictDoUpdate({
        target: userContext.slackUserId,
        set: {
          context: mergedContext,
          updatedAt: new Date(),
        },
      })

  } catch (error) {
    console.error(`Error updating user context for ${slackUserId}:`, error)
  }
}

/**
 * Generate Google OAuth URL for a specific Slack user
 * Includes state parameter to link back to the Slack user after auth
 */
export function generateGoogleOAuthUrl(slackUserId: string, slackTeamId: string): string {
  const state = `slack:${slackUserId}:${slackTeamId}`
  const clientId = process.env.GOOGLE_CLIENT_ID
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.BASE_URL}/auth/google/callback`

  const scopes = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state,
    access_type: 'offline',
    prompt: 'consent', // Force consent to ensure we get refresh token
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}