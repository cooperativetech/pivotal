import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  boolean,
  unique,
  integer,
} from 'drizzle-orm/pg-core'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { WorkflowType, TopicUserContext, UserContext, AutoMessageDeactivation, RecurringMetadata } from '@shared/api-types'
import { organizationTable } from './auth'

export const topicTable = pgTable('topic', {
  id: uuid().primaryKey().defaultRandom(),
  botUserId: text().notNull(),
  workflowType: text().$type<WorkflowType>().notNull().default('other'),
  slackTeamId: text().notNull().references(() => organizationTable.slackTeamId),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
export type TopicInsert = InferInsertModel<typeof topicTable>
export type Topic = InferSelectModel<typeof topicTable>

export const topicStateTable = pgTable('topic_state', {
  id: uuid().primaryKey().defaultRandom(),
  topicId: uuid().notNull().references(() => topicTable.id),
  userIds: jsonb().$type<string[]>().notNull().default([]),
  summary: text().notNull(),
  isActive: boolean().notNull().default(true),
  perUserContext: jsonb().$type<Record<string, TopicUserContext>>().notNull().default({}),
  recurringMetadata: jsonb().$type<RecurringMetadata>().notNull().default({}),
  createdByMessageId: uuid().notNull().references(() => slackMessageTable.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
export type TopicStateInsert = InferInsertModel<typeof topicStateTable>
export type TopicState = InferSelectModel<typeof topicStateTable>

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
  autoMessageId: uuid().references((): AnyPgColumn => autoMessageTable.id),
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

interface RecurrenceSchedule {
  rrule: string // RRULE (RFC 5545) string representing a recurring event
  description: string // human-readable description of the recurrence rule
}

export const autoMessageTable = pgTable('auto_message', {
  id: uuid().primaryKey().defaultRandom(),
  text: text().notNull(),
  nextSendTime: timestamp({ withTimezone: true }),
  recurrenceSchedule: jsonb().$type<RecurrenceSchedule>().notNull(),
  startNewTopic: boolean().notNull().default(false),
  createdByMessageId: uuid().notNull().references((): AnyPgColumn => slackMessageTable.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  deactivationMetadata: jsonb().$type<AutoMessageDeactivation>(),
})
export type AutoMessageInsert = InferInsertModel<typeof autoMessageTable>
export type AutoMessage = InferSelectModel<typeof autoMessageTable>

export const meetingArtifactTable = pgTable('meeting_artifact', {
  id: uuid().primaryKey().defaultRandom(),
  topicId: uuid().notNull().references(() => topicTable.id, { onDelete: 'cascade' }),
  calendarEventId: text().notNull(),
  calendarId: text().notNull(),
  meetingCode: text(),
  meetingUri: text(),
  summary: text(),
  startTime: timestamp({ withTimezone: true }).notNull(),
  endTime: timestamp({ withTimezone: true }).notNull(),
  conferenceRecord: text(),
  transcriptUri: text(),
  transcriptDocumentId: text(),
  transcriptFetchedAt: timestamp({ withTimezone: true }),
  transcriptLastCheckedAt: timestamp({ withTimezone: true }),
  transcriptAttemptCount: integer().notNull().default(0),
  geminiSummary: text(),
  geminiModel: text(),
  summaryPostedAt: timestamp({ withTimezone: true }),
  summarySlackChannelId: text(),
  summarySlackTs: text(),
  originChannelId: text(),
  originThreadTs: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  calendarEventUnique: unique('meeting_artifact_calendar_event_unique').on(table.calendarEventId),
}))
export type MeetingArtifactInsert = InferInsertModel<typeof meetingArtifactTable>
export type MeetingArtifact = InferSelectModel<typeof meetingArtifactTable>
