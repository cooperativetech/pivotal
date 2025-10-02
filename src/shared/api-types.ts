import type { InferResponseType } from 'hono/client'
import { z } from 'zod'

import type { Topic, TopicState, SlackMessage, SlackUser, SlackChannel, UserData } from '../db/schema/main'
import type { local_api } from './api-client'

// Re-export database types for convenience
export type { SlackMessage, SlackUser, SlackChannel, UserData }

export type TopicWithState = Topic & {
  state: TopicState
}

export type TopicStateWithMessageTs = TopicState & {
  createdByMessageRawTs: string
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

export interface UserContext {
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
}

export interface BotRepository {
  id: string
  name: string
  owner: string
  fullName: string
  invitationId: string | null
}

export interface GithubAccount {
  accountId: string
  username: string
  orgName: string | null
  linkedRepo: BotRepository | null
  linkableRepos: BotRepository[]
}

export interface ProfileOrg {
  id: string
  name: string
  slackTeamId: string
  slackAppInstalled: boolean
}

export interface UserProfile {
  user: {
    id: string
    email: string
    name: string
  }
  slackAccount: { accountId: string } | null
  googleAccount: { accountId: string } | null
  githubAccount: GithubAccount | null
  organization: ProfileOrg
}

export interface AutoMessageDeactivation {
  deactivatedReason: 'message' | 'expired'
  deactivatedAt: string // ISO timestamp for time message was deactivated
  deactivatedByMessageId?: string // SlackMessage id of message that caused deactivation
}

export interface TopicData {
  topic: Topic
  states: TopicStateWithMessageTs[]
  messages: SlackMessage[]
  users: SlackUser[]
  userData: UserData[]
  channels: SlackChannel[]
}

type TopicWithStateRes = InferResponseType<typeof local_api.topics['$get'], 200>['topics'][number]
export type TopicDataRes = InferResponseType<typeof local_api.topics[':topicId']['$get'], 200>['topicData']

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
    topic: {
      ...topicRes.topic,
      createdAt: new Date(topicRes.topic.createdAt),
    },
    states: topicRes.states.map((state) => ({
      ...state,
      createdAt: new Date(state.createdAt),
    })),
    messages: topicRes.messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp),
    })),
    users: topicRes.users.map((user) => ({
      ...user,
      updated: new Date(user.updated),
    })),
    userData: topicRes.userData.map((userData) => ({
      ...userData,
      createdAt: new Date(userData.createdAt),
      updatedAt: new Date(userData.updatedAt),
    })),
    channels: topicRes.channels,
  }
}
