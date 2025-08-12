import db from './engine'
import { topicTable, slackMessageTable } from './schema/main'
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
