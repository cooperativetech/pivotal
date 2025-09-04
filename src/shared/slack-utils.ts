import type { SlackUser, SlackUserInsert } from '../db/schema/main'

/**
 * Converts a SlackUserInsert to a SlackUser shape for in-memory usage.
 * Ensures optional fields are present.
 */
export function slackUserInsertToUser(slackUserInsert: SlackUserInsert): SlackUser {
  return {
    ...slackUserInsert,
    realName: slackUserInsert.realName ?? null,
    email: slackUserInsert.email ?? null,
    tz: slackUserInsert.tz ?? null,
  }
}
