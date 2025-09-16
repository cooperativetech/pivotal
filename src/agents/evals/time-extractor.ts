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
  execute: (output) => output,
})

const timeExtractionAgent = new Agent({
  name: 'TimeExtractionAgent',
  model: 'anthropic/claude-sonnet-4',
  toolUseBehavior: { stopAtToolNames: ['extractMeetingTime'] },
  modelSettings: {
    temperature: 0.2,
    toolChoice: 'auto',
  },
  tools: [extractMeetingTime],
  instructions: `You are a meeting time extraction agent. Analyze messages to determine if they contain suggestions for specific meeting times.

Guidelines:
- Look for specific meeting time suggestions
- If no specific time is suggested, OR multiple times are suggested, do NOT use the tool - just respond with "NONE"
- If no end time is specified, assume 1 hour duration
- Use proper ISO 8601 format with timezone offsets
- Provide a brief meeting description

Only use the extractMeetingTime tool if there is exactly one specific meeting time suggested in the message.`,
})

export async function extractSuggestedTime(messageText: string): Promise<SimpleCalendarEvent | null> {
  const prompt = `Analyze this message and determine if it contains a suggestion for a specific meeting time.

For context, today is January 1, 2025, and we're in Eastern Time (EST/EDT).

Message: "${messageText}"

If there is exactly one specific meeting time suggested, use the extractMeetingTime tool.
If no meeting time is suggested, OR multiple times are suggested, respond with "NONE".

Examples:
- "Let's meet at 2 PM tomorrow" → Use tool with start: "2025-01-02T19:00:00-05:00", end: "2025-01-02T20:00:00-05:00"
- "How about 3:30-4:30 PM on Monday?" → Use tool with start: "2025-01-06T20:30:00-05:00", end: "2025-01-06T21:30:00-05:00"
- "We could meet Monday or Tuesday" → Respond with "NONE" (multiple options)`

  try {
    const result = await run(timeExtractionAgent, prompt)

    // Check if tool was used successfully
    if (result.finalOutput && typeof result.finalOutput === 'object' && 'start' in result.finalOutput) {
      const meetingTime = result.finalOutput as z.infer<typeof MeetingTimeOutput>
      const startDate = new Date(meetingTime.start)
      const endDate = new Date(meetingTime.end)

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.warn(`Failed to parse suggested meeting times: ${JSON.stringify(meetingTime)}`)
        return null
      }

      return {
        start: startDate,
        end: endDate,
        summary: meetingTime.summary || 'Meeting',
      }
    }

    // If no tool was used or response is "NONE", return null
    return null
  } catch (error) {
    console.error('Error extracting suggested time with Agent:', error)
    return null
  }
}