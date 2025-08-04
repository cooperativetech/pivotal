import {
  pgTable,
  text,
  timestamp,
  json,
  uuid,
} from 'drizzle-orm/pg-core'
import { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import { GroupChat, WorkflowType } from '../../shared/api-types.ts'

export const chatTable = pgTable('chat', {
  id: text().primaryKey(),
  name: text().notNull(),
  groupChat: json().$type<GroupChat>().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export type ChatInsert = InferInsertModel<typeof chatTable>
export type Chat = InferSelectModel<typeof chatTable>

export const topicTable = pgTable('topic', {
  id: uuid().primaryKey().defaultRandom(),
  userIds: json().$type<string[]>().notNull().default([]),
  summary: text().notNull(),
  workflowType: text().$type<WorkflowType>().notNull().default('other'),
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
