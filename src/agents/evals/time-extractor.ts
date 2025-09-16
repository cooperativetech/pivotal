import { Agent, run } from '../agent-sdk'
import type { SimpleCalendarEvent } from '../../evals/user-sims'

const timeExtractionAgent = new Agent({
  name: 'TimeExtractionAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    temperature: 0.2,
  },
  instructions: `You are a meeting time extraction agent. Analyze messages to determine if they contain suggestions for specific meeting times and extract them in JSON format.

Guidelines:
- Look for specific meeting time suggestions
- If no specific time is suggested, OR multiple times are suggested, respond with "NONE"
- If no end time is specified, assume 1 hour duration
- Use proper ISO 8601 format with timezone offsets
- Provide a brief meeting description

Response format:
- Meeting time found: {"start": "YYYY-MM-DDTHH:MM:SS±HH:MM", "end": "YYYY-MM-DDTHH:MM:SS±HH:MM", "summary": "Brief meeting description"}
- No meeting time found: "NONE"`,
})

export async function extractSuggestedTime(messageText: string): Promise<SimpleCalendarEvent | null> {
  const prompt = `Analyze this message and determine if it contains a suggestion for a specific meeting time. If it does, extract the meeting details in JSON format. If no specific meeting time is suggested, respond with "NONE".

For context, today is January 1, 2025.

Message: "${messageText}"

Response format:
- If a meeting time is suggested: Return it in JSON format: {"start": "YYYY-MM-DDTHH:MM:SS±HH:MM", "end": "YYYY-MM-DDTHH:MM:SS±HH:MM", "summary": "Brief meeting description"}
- If no end time is specified, assume 1 hour duration
- If no meeting time is suggested, OR the message contains multiple suggested times: Return "NONE"

Examples:
- "Let's meet at 2 PM tomorrow" → {"start": "2025-01-02T19:00:00-05:00", "end": "2025-01-02T20:00:00-05:00", "summary": "Meeting"}
- "How about 3:30-4:30 PM on Monday?" → {"start": "2025-01-06T20:30:00-05:00", "end": "2025-01-06T21:30:00-05:00", "summary": "Meeting"}`

  try {
    const result = await run(timeExtractionAgent, prompt)
    const response = result.finalOutput?.trim()

    if (!response || response === 'NONE' || response.toLowerCase() === 'none') {
      return null
    }

    // Try to parse the JSON response
    try {
      // Strip markdown code blocks if present
      let jsonString = response
      if (response.includes('```json')) {
        const jsonMatch = response.match(/```json\s*\n([\s\S]*?)\n\s*```/)
        if (jsonMatch) {
          jsonString = jsonMatch[1]
        }
      } else if (response.includes('```')) {
        const codeMatch = response.match(/```\s*\n([\s\S]*?)\n\s*```/)
        if (codeMatch) {
          jsonString = codeMatch[1]
        }
      }

      const parsed = JSON.parse(jsonString.trim()) as Record<string, unknown>

      const startDate = new Date(parsed.start as string)
      const endDate = new Date(parsed.end as string)

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        console.warn(`Failed to parse suggested meeting times: ${jsonString}`)
        return null
      }

      return {
        start: startDate,
        end: endDate,
        summary: (parsed.summary as string) || 'Meeting',
      }
    } catch {
      console.warn(`No time extracted: ${response}`)
      return null
    }
  } catch (error) {
    console.error('Error extracting suggested time with Agent:', error)
    return null
  }
}