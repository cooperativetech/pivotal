import type { WorkflowType } from '@shared/api-types'
import type { ConversationAgent } from './conversation-utils'
import { schedulingAgent } from './schedule-next-step'
import { meetingPrepAgent } from './meeting-prep'

export const workflowAgentMap = new Map<WorkflowType, ConversationAgent>([
  ['scheduling', schedulingAgent],
  ['meeting-prep', meetingPrepAgent],
])

export { analyzeTopicRelevance } from './analyze-topic-relevance'
export { genFakeCalendar } from './gen-fake-calendar'
export { runConversationAgent } from './conversation-utils'
