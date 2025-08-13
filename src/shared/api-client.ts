import { hc, InferResponseType } from 'hono/client'
import type { AppType } from '../flack-server'
import type { TopicData } from '../utils'

const API_BASE_URL = 'http://localhost:3001'

export const api = hc<AppType>(API_BASE_URL).api

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
  }
}

