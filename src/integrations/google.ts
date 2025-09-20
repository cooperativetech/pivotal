import { and, eq } from 'drizzle-orm'
import db from '../db/engine'
import { auth } from '../auth'
import { accountTable } from '../db/schema/auth'

export async function getLinkedGoogleAccount(userId: string) {
  const [linkedGoogleAccount] = await db.select()
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'google'),
    ))
    .limit(1)

  if (!linkedGoogleAccount) {
    return null
  }

  // Check that the account credentials are still valid
  try {
    await auth.api.getAccessToken({
      body: {
        providerId: 'google',
        userId,
        accountId: linkedGoogleAccount.id,
      },
    })
  } catch (error) {
    if (
      error && typeof error === 'object' && 'message' in error &&
      error.message === 'Failed to get a valid access token'
    ) {
      console.error(`Google refresh token invalid for user, unlinking account: ${userId}`)
      await db.delete(accountTable).where(eq(accountTable.id, linkedGoogleAccount.id))
      return null
    }
    throw error
  }

  return {
    accountId: linkedGoogleAccount.accountId,
  }
}
