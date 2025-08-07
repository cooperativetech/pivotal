import {
  pgTable,
  text,
  timestamp,
  json,
  uuid,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core'
import { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import { WorkflowType } from '../../shared/api-types.ts'

export const topicTable = pgTable('topic', {
  id: uuid().primaryKey().defaultRandom(),
  userIds: json().$type<string[]>().notNull().default([]),
  summary: text().notNull(),
  workflowType: text().$type<WorkflowType>().notNull().default('other'),
  isActive: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})

export type TopicInsert = InferInsertModel<typeof topicTable>
export type Topic = InferSelectModel<typeof topicTable>

export const slackMessageTable = pgTable('slack_message', {
  id: uuid().primaryKey().defaultRandom(),
  topicId: uuid().notNull().references(() => topicTable.id),
  channelId: text().notNull(),
  userId: text().notNull(),
  text: text().notNull(),
  timestamp: timestamp({ withTimezone: true }).notNull(),
  raw: json(),
})

export type SlackMessageInsert = InferInsertModel<typeof slackMessageTable>
export type SlackMessage = InferSelectModel<typeof slackMessageTable>

export const slackUserMapping = pgTable('slack_user_mapping', {
  slackUserId: text('slack_user_id').primaryKey(),
  googleAccessToken: text('google_access_token'),
  googleRefreshToken: text('google_refresh_token'),
  googleTokenExpiresAt: timestamp('google_token_expires_at', { withTimezone: true }),
  slackTeamId: text('slack_team_id').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  slackUserName: text('slack_user_name'),
  slackDisplayName: text('slack_display_name'),
})

export type SlackUserMappingInsert = InferInsertModel<typeof slackUserMapping>
export type SlackUserMapping = InferSelectModel<typeof slackUserMapping>

export const userContext = pgTable('user_context', {
  slackUserId: text('slack_user_id').primaryKey().references(() => slackUserMapping.slackUserId),
  context: jsonb('context').default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})

export type UserContextInsert = InferInsertModel<typeof userContext>
export type UserContext = InferSelectModel<typeof userContext>
