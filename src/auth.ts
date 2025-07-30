import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import db from './db/engine.ts'
import * as schema from './db/schema/auth.ts'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: { enabled: true },
  trustedOrigins: ['http://localhost:5173'],
})
