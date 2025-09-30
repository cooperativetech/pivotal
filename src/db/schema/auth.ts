import {
  pgTable,
  text,
  timestamp,
  boolean,
} from 'drizzle-orm/pg-core'

export const userTable = pgTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().$onUpdate(() => new Date()),
})

export const sessionTable = pgTable('session', {
  id: text().primaryKey(),
  expiresAt: timestamp().notNull(),
  token: text().notNull().unique(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().$onUpdate(() => new Date()),
  ipAddress: text(),
  userAgent: text(),
  userId: text().notNull().references(() => userTable.id, { onDelete: 'cascade' }),
})

export const accountTable = pgTable('account', {
  id: text().primaryKey(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull().references(() => userTable.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp(),
  refreshTokenExpiresAt: timestamp(),
  scope: text(),
  password: text(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().$onUpdate(() => new Date()),
  installationId: text(),
  repositoryId: text(),
})

export const verificationTable = pgTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().$onUpdate(() => new Date()),
})

export const betterAuthSchema = {
  user: userTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable,
}
