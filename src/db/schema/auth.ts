import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
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
export type UserInsert = InferInsertModel<typeof userTable>
export type User = InferSelectModel<typeof userTable>

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
export type SessionInsert = InferInsertModel<typeof sessionTable>
export type Session = InferSelectModel<typeof sessionTable>

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
export type AccountInsert = InferInsertModel<typeof accountTable>
export type Account = InferSelectModel<typeof accountTable>

export const verificationTable = pgTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp().notNull(),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow().$onUpdate(() => new Date()),
})
export type VerificationInsert = InferInsertModel<typeof verificationTable>
export type Verification = InferSelectModel<typeof verificationTable>

export const organizationTable = pgTable('organization', {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().unique(),
  logo: text(),
  createdAt: timestamp().notNull().defaultNow(),
  metadata: text(),
  slackTeamId: text().notNull().unique(),
})
export type OrganizationInsert = InferInsertModel<typeof organizationTable>
export type Organization = InferSelectModel<typeof organizationTable>

export const memberTable = pgTable('member', {
  id: text().primaryKey(),
  organizationId: text().notNull().references(() => organizationTable.id, { onDelete: 'cascade' }),
  userId: text().notNull().references(() => userTable.id, { onDelete: 'cascade' }),
  role: text().default('member').notNull(),
  createdAt: timestamp().notNull().defaultNow(),
})
export type MemberInsert = InferInsertModel<typeof memberTable>
export type Member = InferSelectModel<typeof memberTable>

export const invitationTable = pgTable('invitation', {
  id: text().primaryKey(),
  organizationId: text().notNull().references(() => organizationTable.id, { onDelete: 'cascade' }),
  email: text().notNull(),
  role: text(),
  status: text().default('pending').notNull(),
  expiresAt: timestamp().notNull(),
  inviterId: text().notNull().references(() => userTable.id, { onDelete: 'cascade' }),
})
export type InvitationInsert = InferInsertModel<typeof invitationTable>
export type Invitation = InferSelectModel<typeof invitationTable>

export const betterAuthSchema = {
  user: userTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable,
  organization: organizationTable,
  member: memberTable,
  invitation: invitationTable,
}
