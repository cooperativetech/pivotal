import type { WorkflowType } from '@shared/api-types'
import type { ConversationAgent } from './conversation-utils'
import { schedulingAgent } from './scheduling'
import { meetingPrepAgent } from './meeting-prep'
import { queryAgent } from './queries'

export const workflowAgentMap = new Map<WorkflowType, ConversationAgent>([
  ['scheduling', schedulingAgent],
  ['meeting-prep', meetingPrepAgent],
  ['queries', queryAgent],
])

export { analyzeTopicRelevance } from './analyze-topic-relevance'
export { genFakeCalendar } from './gen-fake-calendar'
export { runConversationAgent } from './conversation-utils'
