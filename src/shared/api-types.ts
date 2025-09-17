import type { InferResponseType } from 'hono/client'
import { z } from 'zod'

import type { Topic, TopicState, SlackMessage, SlackUser, SlackChannel, UserData } from '../db/schema/main'
import type { local_api } from './api-client'

// Re-export database types for convenience
export type { SlackMessage, SlackUser, SlackChannel, UserData }

export type TopicWithState = Topic & {
  state: TopicState
}

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
  // Pointer to the DM message where we showed calendar connect buttons
  calendarPromptMessage?: { channelId: string, ts: string }
  // Stores the scheduled event created for this topic (used for rescheduling)
  scheduledEvent?: {
    organizer: 'bot' | 'leader'
    calendarId: string
    eventId: string
    meetLink?: string | null
    title?: string | null
  }
  // Optional legacy/plural form used by some prompts/UI
  scheduledEvents?: ScheduledEvent[]
}

// Lightweight representation of a scheduled calendar event stored in topic context
export interface ScheduledEvent {
  provider?: 'google' // default google if omitted (backward-compatible)
  calendarId: string
  eventId?: string | null
  iCalUID?: string | null
  start?: string | null // ISO
  end?: string | null   // ISO
  title?: string | null
  meetLink?: string | null
  conferenceId?: string | null
  meetCode?: string | null
  participantEmails?: string[] | null
  // Drive/Docs artifacts
  transcriptFileId?: string | null
  transcriptUrl?: string | null
  transcriptStatus?: 'pending' | 'found' | 'missing' | 'error' | null
  transcriptSharedWith?: string[] | null
  summaryFileId?: string | null
  summaryUrl?: string | null
  summaryStatus?: 'pending' | 'found' | 'missing' | 'error' | null
  summarySharedWith?: string[] | null
  summarySlackMessageTs?: string | null
  // Slack posting metadata for follow-ups
  slackChannelId?: string | null
  slackThreadTs?: string | null
  status?: 'scheduled' | 'cancelled' | 'updated' | null
}

export interface AutoMessageDeactivation {
  deactivatedReason: 'message' | 'expired'
  deactivatedAt: string // ISO timestamp for time message was deactivated
  deactivatedByMessageId?: string // SlackMessage id of message that caused deactivation
}

export interface TopicData {
  topic: TopicWithState
  messages: SlackMessage[]
  users: SlackUser[]
  userData: UserData[]
  channels: SlackChannel[]
}

type TopicWithStateRes = InferResponseType<typeof local_api.topics['$get'], 200>['topics'][number]
export type TopicDataRes = InferResponseType<typeof local_api.topics[':topicId']['$get'], 200>

export function unserializeTopicWithState(topic: TopicWithStateRes): TopicWithState {
  return {
    ...topic,
    createdAt: new Date(topic.createdAt),
    state: {
      ...topic.state,
      createdAt: new Date(topic.state.createdAt),
    },
  }
}

export function unserializeTopicData(topicRes: TopicDataRes): TopicData {
  return {
    topic: unserializeTopicWithState(topicRes.topic),
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
