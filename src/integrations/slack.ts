import { and, eq } from 'drizzle-orm'
import db from '../db/engine'
import { accountTable } from '../db/schema/auth'

export async function getLinkedSlackAccount(userId: string) {
  const [linkedSlackAccount] = await db.select()
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'slack'),
    ))
    .limit(1)

  if (!linkedSlackAccount) {
    return null
  }

  return {
    accountId: linkedSlackAccount.accountId,
  }
}
