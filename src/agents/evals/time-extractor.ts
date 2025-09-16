import { z } from 'zod'
import { Agent, run, tool } from '../agent-sdk'
import type { SimpleCalendarEvent } from '../../evals/user-sims'

const MeetingTimeOutput = z.strictObject({
  start: z.string().describe('Meeting start time in ISO 8601 format with timezone offset'),
  end: z.string().describe('Meeting end time in ISO 8601 format with timezone offset'),
  summary: z.string().describe('Brief meeting description'),
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
  model: 'anthropic/claude-sonnet-4',
  toolUseBehavior: {
    stopAtToolNames: ['extractMeetingTime'],
    requireToolUse: false,
  },
  modelSettings: {
    temperature: 0.1,
    toolChoice: 'auto',
  },
  tools: [extractMeetingTime],
  instructions: `You are a meeting time extraction agent. Your job is to identify if a message contains exactly one specific meeting time.

CRITICAL: When you find exactly one specific meeting time, you MUST use the extractMeetingTime tool with:
- start: ISO 8601 format with timezone (e.g., "2025-01-02T17:00:00-05:00")
- end: ISO 8601 format with timezone (e.g., "2025-01-02T18:00:00-05:00")
- summary: Brief description (e.g., "Meeting")

If you find exactly one specific time, use the tool. If not, respond with "NONE".

DO NOT explain or describe the time in text - use the tool to extract it.`,
})

export async function extractSuggestedTime(messageText: string): Promise<SimpleCalendarEvent | null> {
  const prompt = `Analyze this message and determine if it contains a suggestion or confirmation for a specific meeting time.

For context, today is January 1, 2025, and we're in Eastern Time (EST/EDT).

Message: "${messageText}"

If there is exactly one specific meeting time suggested OR confirmed, use the extractMeetingTime tool.
If no meeting time is suggested/confirmed, OR multiple times are suggested, respond with "NONE".

Examples:
- "Let's meet at 2 PM tomorrow" → Use tool with start: "2025-01-02T19:00:00-05:00", end: "2025-01-02T20:00:00-05:00"
- "How about 3:30-4:30 PM on Monday?" → Use tool with start: "2025-01-06T20:30:00-05:00", end: "2025-01-06T21:30:00-05:00"
- "Meeting confirmed: Thursday, January 2nd at 12:00-1:00 PM (EDT)" → Use tool with start: "2025-01-02T17:00:00-05:00", end: "2025-01-02T18:00:00-05:00"
- "Meeting confirmed! Thursday, January 2nd from 12:00-1:00 PM (EDT) with Alice and Bob." → Use tool with start: "2025-01-02T17:00:00-05:00", end: "2025-01-02T18:00:00-05:00"
- "Great! I have a time that works for both of you: **Thursday, January 2nd at 12:00-1:00 PM (EDT)** Alice and Bob - please confirm this time works for your final schedules." → Use tool with start: "2025-01-02T17:00:00-05:00", end: "2025-01-02T18:00:00-05:00"
- "Great! Alice has confirmed Thursday, January 2nd from 12:00-1:00 PM (EDT). Bob, does this time work for you?" → Use tool with start: "2025-01-02T17:00:00-05:00", end: "2025-01-02T18:00:00-05:00"
- "We could meet Monday or Tuesday" → Respond with "NONE" (multiple options)`

  try {
    const result = await run(timeExtractionAgent, prompt)

    // Debug logging to understand agent behavior
    console.log(`🔍 Time extraction debug for: "${messageText.slice(0, 100)}${messageText.length > 100 ? '...' : ''}"`)
    console.log(`   Agent response: ${JSON.stringify(result.lastMessage?.text || 'No text response')}`)
    console.log(`   Tool used: ${result.finalOutput ? 'Yes' : 'No'}`)
    console.log(`   Final output: ${JSON.stringify(result.finalOutput)}`)

    // Check if tool was used successfully
    if (result.finalOutput && typeof result.finalOutput === 'object' && 'start' in result.finalOutput) {
      const meetingTime = result.finalOutput as z.infer<typeof MeetingTimeOutput>
      console.log(`   🔧 Extracted meeting time object: ${JSON.stringify(meetingTime)}`)

      const startDate = new Date(meetingTime.start)
      const endDate = new Date(meetingTime.end)

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.warn(`   ❌ Failed to parse suggested meeting times: ${JSON.stringify(meetingTime)}`)
        return null
      }

      console.log(`   ✅ Successfully extracted meeting time`)
      return {
        start: startDate,
        end: endDate,
        summary: meetingTime.summary || 'Meeting',
      }
    } else if (result.finalOutput && typeof result.finalOutput === 'string') {
      console.log(`   ⚠️  Agent returned text instead of tool output: "${result.finalOutput}"`)
    }

    // If no tool was used or response is "NONE", return null
    console.log(`   ❌ No meeting time extracted`)
    return null
  } catch (error) {
    console.error('Error extracting suggested time with Agent:', error)
    return null
  }
}