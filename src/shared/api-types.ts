import type { InferResponseType } from 'hono/client'
import type { Topic, SlackMessage, SlackUser, SlackChannel, UserData } from '../db/schema/main'
import type { api } from './api-client'

// Re-export database types for convenience
export type { Topic, SlackMessage, SlackUser, SlackChannel, UserData }

export interface CalendarEvent {
  start: string // Date ISO string
  end: string // Date ISO string
  summary: string
}

export interface UserContext {
  googleAccessToken?: string
  googleRefreshToken?: string
  googleTokenExpiryDate?: number
  calendar?: CalendarEvent[]
  calendarLastFetched?: string
  slackTeamId?: string
  slackUserName?: string
  slackDisplayName?: string
}

export interface TopicData {
  topic: Topic
  messages: SlackMessage[]
  users: SlackUser[]
  userData?: UserData[]
  channels?: SlackChannel[]
}

export type TopicRes = InferResponseType<typeof api.topics[':topicId']['$get'], 200>

export function unserializeTopicTimestamps(topicRes: TopicRes): TopicData {
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