import db from './engine'
import { topicTable, slackMessageTable, slackUserMapping, slackUserTable } from './schema/main'
import { sql } from 'drizzle-orm'

/**
 * Efficiently clears all test data from the database using TRUNCATE
 * Falls back to DELETE if TRUNCATE fails (e.g., due to permissions)
 */
export const cleanupTestData = async () => {
  try {
    // TRUNCATE is faster and resets auto-increment counters
    // CASCADE handles foreign key constraints automatically
    await db.execute(sql`TRUNCATE TABLE ${slackMessageTable} CASCADE`)
    await db.execute(sql`TRUNCATE TABLE ${topicTable} CASCADE`)
    console.log('✅ Database cleared using TRUNCATE')
    return { method: 'TRUNCATE', success: true }
  } catch (error) {
    // Fallback to DELETE if TRUNCATE fails
    console.log('TRUNCATE failed, falling back to DELETE:', error)
    try {
      // Delete in correct order for foreign key constraints
      await db.delete(slackMessageTable)
      await db.delete(topicTable)
      console.log('✅ Database cleared using DELETE')
      return { method: 'DELETE', success: true }
    } catch (deleteError) {
      console.error('Failed to clear database:', deleteError)
      throw deleteError
    }
  }
}

/**
 * Gets count of records in test tables
 */
export const getTestDataCounts = async () => {
  const topicCount = await db.select({ count: sql`count(*)` }).from(topicTable)
  const messageCount = await db.select({ count: sql`count(*)` }).from(slackMessageTable)

  return {
    topics: Number(topicCount[0].count),
    messages: Number(messageCount[0].count),
  }
}

/**
 * Sets up test users for evaluation
 */
export const setupTestUsers = async () => {
  const testUsers = [
    { id: 'U_USER_0', name: 'Alice', displayName: 'Alice Johnson', realName: 'Alice' },
    { id: 'U_USER_1', name: 'Bob', displayName: 'Bob Smith', realName: 'Bob' },
    { id: 'U_USER_2', name: 'Charlie', displayName: 'Charlie Brown', realName: 'Charlie' },
    { id: 'U_USER_3', name: 'Diana', displayName: 'Diana Prince', realName: 'Diana' },
    { id: 'U_USER_4', name: 'Eve', displayName: 'Eve Adams', realName: 'Eve' },
  ]

  try {
    // Insert test users into slack_user_mapping table
    for (const user of testUsers) {
      await db
        .insert(slackUserMapping)
        .values({
          slackUserId: user.id,
          slackTeamId: 'T_TEST_TEAM',
          slackUserName: user.name,
          slackDisplayName: user.displayName,
        })
        .onConflictDoNothing()

      // Also insert into slackUserTable
      await db
        .insert(slackUserTable)
        .values({
          id: user.id,
          teamId: 'T_TEST_TEAM',
          realName: user.realName,
          tz: 'America/New_York',
          isBot: false,
          deleted: false,
          updated: new Date(),
          raw: {
            id: user.id,
            team_id: 'T_TEST_TEAM',
            real_name: user.realName,
            is_bot: false,
            deleted: false,
            updated: Math.floor(Date.now() / 1000),
          },
        })
        .onConflictDoNothing()
    }
    console.log('✅ Test users set up successfully')
  } catch (error) {
    console.error('Error setting up test users:', error)
  }
}