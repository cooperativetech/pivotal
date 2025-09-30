import { z } from 'zod'
import { Agent, run, tool } from '../agent-sdk'
import type { SimpleCalendarEvent } from '../../evals/sim-users'

const MeetingTimeOutput = z.strictObject({
  start: z.string().describe('Meeting start time in ISO 8601 format with timezone offset, or "NONE" if no meeting time found'),
  end: z.string().describe('Meeting end time in ISO 8601 format with timezone offset, or "NONE" if no meeting time found'),
  summary: z.string().describe('Brief meeting description, or "NONE" if no meeting time found'),
})

const extractMeetingTime = tool({
  name: 'extractMeetingTime',
  description: 'Extract a specific meeting time suggestion from a message',
  parameters: MeetingTimeOutput,
  strict: true,
  execute: (output) => {
    console.log(`🔧 Tool executed with output: ${JSON.stringify(output)}`)
    return output
  },
})

const timeExtractionAgent = new Agent({
  name: 'TimeExtractionAgent',
  model: 'google/gemini-2.5-flash',
  // model: 'anthropic/claude-sonnet-4.5', // fallback if gemini doesn't work well
  toolUseBehavior: {
    stopAtToolNames: ['extractMeetingTime'],
  },
  modelSettings: {
    temperature: 0.1,
    toolChoice: 'auto', // gemini doesn't support 'required', use 'auto' instead
  },
  tools: [extractMeetingTime],
  outputType: MeetingTimeOutput,
  instructions: `You are a meeting time extraction agent. Your job is to identify if a message contains exactly one specific meeting time.

You MUST always use the extractMeetingTime tool.

IMPORTANT: For timezone handling, use the LOCAL time with the timezone offset:
- "12:00 PM (EST)" = "2025-01-02T12:00:00-05:00" (NOT "2025-01-02T17:00:00-05:00")
- "2:00 PM" = "2025-01-02T14:00:00-05:00" (assuming EST in January)

If you find exactly one specific meeting time:
- start: Local time with timezone offset (e.g., "2025-01-02T12:00:00-05:00")
- end: Local time with timezone offset (e.g., "2025-01-02T13:00:00-05:00")
- summary: Brief description (e.g., "Meeting")

If you find no meeting time OR multiple meeting times:
- start: "NONE"
- end: "NONE"
- summary: "NONE"

Always use the tool with the appropriate values.`,
})

export async function extractSuggestedTime(messageText: string): Promise<SimpleCalendarEvent | null> {
  const prompt = `Analyze this message and determine if it contains a suggestion or confirmation for a specific meeting time.

For context, today is January 1, 2025, and we're in Eastern Time (EST/EDT).

Message: "${messageText}"

If there is exactly one specific meeting time suggested OR confirmed, use the extractMeetingTime tool.
If no meeting time is suggested/confirmed, OR multiple times are suggested, respond with "NONE".

Examples:
- "Let's meet at 2 PM tomorrow" → Use tool with start: "2025-01-02T14:00:00-05:00", end: "2025-01-02T15:00:00-05:00"
- "How about 3:30-4:30 PM on Monday?" → Use tool with start: "2025-01-06T15:30:00-05:00", end: "2025-01-06T16:30:00-05:00"
- "Meeting confirmed: Thursday, January 2nd at 12:00-1:00 PM (EDT)" → Use tool with start: "2025-01-02T12:00:00-05:00", end: "2025-01-02T13:00:00-05:00"
- "Meeting confirmed! Thursday, January 2nd from 12:00-1:00 PM (EDT) with Alice and Bob." → Use tool with start: "2025-01-02T12:00:00-05:00", end: "2025-01-02T13:00:00-05:00"
- "Great! I have a time that works for both of you: **Thursday, January 2nd at 12:00-1:00 PM (EDT)** Alice and Bob - please confirm this time works for your final schedules." → Use tool with start: "2025-01-02T12:00:00-05:00", end: "2025-01-02T13:00:00-05:00"
- "Great! Alice has confirmed Thursday, January 2nd from 12:00-1:00 PM (EDT). Bob, does this time work for you?" → Use tool with start: "2025-01-02T12:00:00-05:00", end: "2025-01-02T13:00:00-05:00"
- "We could meet Monday or Tuesday" → Respond with "NONE" (multiple options)`

  try {
    const result = await run(timeExtractionAgent, prompt)

    // Debug logging to understand agent behavior
    console.log('🔍 Time extraction:')
    console.log(`   Final output: ${JSON.stringify(result.finalOutput)}`)

    if (!result.finalOutput) {
      console.log('   ❌ No output generated')
      return null
    }

    // Check if agent found a meeting time or returned "NONE"
    if (result.finalOutput.start === 'NONE' || result.finalOutput.end === 'NONE' || result.finalOutput.summary === 'NONE') {
      console.log('   ℹ️  Agent found no meeting time')
      return null
    }

    // Parse the dates - JavaScript correctly handles timezone-aware ISO strings
    const startDate = new Date(result.finalOutput.start)
    const endDate = new Date(result.finalOutput.end)

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      console.warn(`   ❌ Failed to parse meeting times: ${JSON.stringify(result.finalOutput)}`)
      return null
    }

    console.log(`   ✅ Successfully extracted meeting time: ${startDate.toISOString()} - ${endDate.toISOString()}`)
    return {
      start: startDate,
      end: endDate,
      summary: result.finalOutput.summary || 'Meeting',
    }
  } catch (error) {
    console.error('Error extracting suggested time with Agent:', error)
    return null
  }
}