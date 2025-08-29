import type { SlackUser, SlackUserInsert } from '../db/schema/main'

/**
 * Converts a SlackUserInsert to a SlackUser by adding the authUserId field
 * Preserves all existing data from the SlackUserInsert
 */
export function slackUserInsertToUser(slackUserInsert: SlackUserInsert, authUserId: string | null = null): SlackUser {
  return {
    ...slackUserInsert,
    realName: slackUserInsert.realName ?? null,
    email: slackUserInsert.email ?? null,
    tz: slackUserInsert.tz ?? null,
    authUserId,
  }
}