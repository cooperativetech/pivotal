/**
 * JSON Extraction Tool
 * 
 * Converts LLM reasoning/analysis text into structured JSON format
 * for the scheduleNextStep function response.
 */

export interface ScheduleStepResponse {
  action: 'identify_users' | 'request_calendar_access' | 'gather_constraints' | 'finalize' | 'complete' | 'other'
  replyMessage: string
  updateUserIds?: string[]
  updateUserNames?: string[]
  updateSummary?: string
  markTopicInactive?: boolean
  messagesToUsers?: {
    userIds: string[]
    userNames?: string[]
    text: string
  }[]
  groupMessage?: string
  reasoning: string
}

/**
 * Extract structured JSON from LLM reasoning text
 * @param reasoningText - The LLM's analysis/reasoning text
 * @param userDirectory - Available user names for mapping
 * @param context - Additional context about the scheduling state
 * @returns Structured JSON matching ScheduleStepResponse format
 */
export function extractScheduleJSON(
  _reasoningText: string,
  _userDirectory: string[],
  _context: {
    topicSummary: string
    usersInvolved: string[]
    hasCalendarData: boolean
  }
): ScheduleStepResponse {
  // This function provides structure for the LLM tool to follow
  // The actual extraction logic is handled by the LLM tool call
  throw new Error('This function should not be called directly - use the extractJSON tool instead')
}