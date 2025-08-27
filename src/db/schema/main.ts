import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  boolean,
  unique,
} from 'drizzle-orm/pg-core'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { TopicUserContext, UserContext } from '@shared/api-types'

export type WorkflowType = 'scheduling' | 'other'

export const topicTable = pgTable('topic', {
  id: uuid().primaryKey().defaultRandom(),
  userIds: jsonb().$type<string[]>().notNull().default([]),
  botUserId: text().notNull(),
  summary: text().notNull(),
  workflowType: text().$type<WorkflowType>().notNull().default('other'),
  isActive: boolean().notNull().default(true),
  perUserContext: jsonb().$type<Record<string, TopicUserContext>>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})
export type TopicInsert = InferInsertModel<typeof topicTable>
export type Topic = InferSelectModel<typeof topicTable>

export const slackMessageTable = pgTable('slack_message', {
  id: uuid().primaryKey().defaultRandom(),
  topicId: uuid().notNull().references(() => topicTable.id),
  userId: text().notNull(),
  channelId: text().notNull(),
  text: text().notNull(),
  timestamp: timestamp({ withTimezone: true }).notNull(),
  rawTs: text('raw_ts').notNull(),
  threadTs: text('thread_ts'),
  raw: jsonb().notNull(),
})
export type SlackMessageInsert = InferInsertModel<typeof slackMessageTable>
export type SlackMessage = InferSelectModel<typeof slackMessageTable>

export const slackUserTable = pgTable('slack_user', {
  id: text().primaryKey(),
  teamId: text().notNull(),
  realName: text(),
  email: text(),
  tz: text(),
  isBot: boolean().notNull(),
  deleted: boolean().notNull(),
  updated: timestamp({ withTimezone: true }).notNull(),
  raw: jsonb().notNull(),
})
export type SlackUserInsert = InferInsertModel<typeof slackUserTable>
export type SlackUser = InferSelectModel<typeof slackUserTable>

export const slackChannelTable = pgTable('slack_channel', {
  id: text().primaryKey(),
  userIds: jsonb().$type<string[]>().notNull(),
})
export type SlackChannelInsert = InferInsertModel<typeof slackChannelTable>
export type SlackChannel = InferSelectModel<typeof slackChannelTable>

export const userDataTable = pgTable('user_data', {
  id: uuid().primaryKey().defaultRandom(),
  slackUserId: text().notNull().references(() => slackUserTable.id),
  context: jsonb().$type<UserContext>().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  slackUserIdUnique: unique('user_data_slack_user_id_unique').on(table.slackUserId),
}))
export type UserDataInsert = InferInsertModel<typeof userDataTable>
export type UserData = InferSelectModel<typeof userDataTable>
