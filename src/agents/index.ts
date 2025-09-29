import type { WorkflowType } from '@shared/api-types'
import type { ConversationAgent } from './conversation-utils'
import { schedulingAgent } from './scheduling'
import { meetingPrepAgent } from './meeting-prep'
import { calendarAgent } from './calendar'

export const workflowAgentMap = new Map<WorkflowType, ConversationAgent>([
  ['scheduling', schedulingAgent],
  ['meeting-prep', meetingPrepAgent],
  ['calendar-support', calendarAgent],
])

export { analyzeTopicRelevance } from './analyze-topic-relevance'
export { genFakeCalendar } from './gen-fake-calendar'
export { runConversationAgent } from './conversation-utils'
