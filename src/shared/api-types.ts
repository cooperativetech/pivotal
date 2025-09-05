import type { InferResponseType } from 'hono/client'
import { z } from 'zod'

import type { Topic, SlackMessage, SlackUser, SlackChannel, UserData } from '../db/schema/main'
import type { local_api } from './api-client'

// Re-export database types for convenience
export type { Topic, SlackMessage, SlackUser, SlackChannel, UserData }

export const WorkflowType = z.enum(['scheduling', 'meeting-prep', 'other'])
export type WorkflowType = z.infer<typeof WorkflowType>

export const CalendarEvent = z.strictObject({
  start: z.string().describe('ISO timestamp for the start of the event'),
  end: z.string().describe('ISO timestamp for the end of the event'),
  summary: z.string().describe('Description of the event (e.g., "Available", "Busy", "Meeting")'),
  free: z.boolean().optional().nullable().describe('Whether the user is free during this time (default: false, meaning busy)'),
  participantEmails: z.array(z.string()).optional().nullable().describe('List of participant email addresses'),
})
export type CalendarEvent = z.infer<typeof CalendarEvent>

/**
 * CalendarRangeLastFetched tracks the last fetched time range from the calendar
 */
export interface CalendarRangeLastFetched {
  startTime: string // ISO timestamp for start of fetched range
  endTime: string   // ISO timestamp for end of fetched range
  fetchedAt: string // ISO timestamp for when this range was fetched
}

export interface UserContext {
  googleAccessToken?: string
  googleRefreshToken?: string
  googleTokenExpiryDate?: number
  calendar?: CalendarEvent[]
  calendarRangeLastFetched?: CalendarRangeLastFetched
  slackTeamId?: string
  slackUserName?: string
  slackDisplayName?: string
  suppressCalendarPrompt?: boolean
}

export interface TopicUserContext {
  calendarPrompted?: boolean
  calendarManualOverrides?: CalendarEvent[]
}

export interface AutoMessageDeactivation {
  deactivatedReason: 'message' | 'expired'
  deactivatedAt: string // ISO timestamp for time message was deactivated
  deactivatedByMessageId?: string // SlackMessage id of message that caused deactivation
}

export interface TopicData {
  topic: Topic
  messages: SlackMessage[]
  users: SlackUser[]
  userData?: UserData[]
  channels?: SlackChannel[]
}

export type TopicRes = InferResponseType<typeof local_api.topics[':topicId']['$get'], 200>

export function unserializeTopicData(topicRes: TopicRes): TopicData {
  return {
    topic: {
      ...topicRes.topic,
      createdAt: new Date(topicRes.topic.createdAt),
      updatedAt: new Date(topicRes.topic.updatedAt),
    },
    messages: topicRes.messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp),
    })),
    users: topicRes.users.map((user) => ({
      ...user,
      updated: new Date(user.updated),
    })),
    userData: topicRes.userData?.map((userData) => ({
      ...userData,
      createdAt: new Date(userData.createdAt),
      updatedAt: new Date(userData.updatedAt),
    })),
    channels: topicRes.channels,
  }
}
