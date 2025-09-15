import { Agent, run } from '../../agents/agent-sdk'
import type { SimpleCalendarEvent } from './user-agents'

// Helper function to format calendar events with date and time information
function formatCalendarEvents(calendar: SimpleCalendarEvent[]): string {
  const calendarText = calendar.map((event) => {
    const startDate = event.start.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric' 
    })
    const startTime = event.start.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: false 
    })
    const endTime = event.end.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: false 
    })
    
    // Check if the event spans multiple days
    const sameDay = event.start.toDateString() === event.end.toDateString()
    
    if (sameDay) {
      return `${startDate} ${startTime}-${endTime}: ${event.summary}`
    } else {
      const endDate = event.end.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric' 
      })
      return `${startDate} ${startTime} - ${endDate} ${endTime}: ${event.summary}`
    }
  }).join(', ')

  return calendarText || 'Free all day'
}

// Agent for generating replies using Agent SDK
export class GenerateReplyAgent {
  private agent: Agent

  constructor() {
    this.agent = new Agent({
      name: 'GenerateReplyAgent',
      model: 'anthropic/claude-sonnet-4',
      modelSettings: {
        temperature: 0.8,
      },
      instructions: `You are a reply generation agent. Given a user's context (name, goal, calendar, message history), generate a natural and professional reply to the latest message.

Guidelines:
- Be brief and professional
- Consider the user's calendar when discussing scheduling
- Stay true to the user's goal and personality
- Respond naturally to the conversation context
- Keep responses concise (1-2 sentences typically)`,
    })
  }

  async generateReply(userName: string, goal: string, calendar: SimpleCalendarEvent[], messageBuffer: string[], history: import('./user-agents').HistoryMessage[]): Promise<string> {
    if (messageBuffer.length === 0) {
      return ''
    }

    const latestMessage = messageBuffer[messageBuffer.length - 1]
    
    // Format calendar using helper function
    const calendarText = formatCalendarEvents(calendar)

    // Format conversation history
    const historyText = history.length > 0 
      ? history.map((h) => `${h.sender === 'bot' ? 'Bot' : userName}: ${h.message}`).join('\n')
      : 'No previous conversation'

    const goalContext = goal && goal.trim() !== '' ? `Your goal is: ${goal}\n\n` : ''
    const prompt = `You are ${userName}. ${goalContext}Your calendar: ${calendarText}

Conversation history:
${historyText}

Current messages to respond to: ${messageBuffer.join(' | ')}

Respond naturally to: "${latestMessage}"

Generate only the reply text, nothing else.`

    try {
      const result = await run(this.agent, prompt)
      return result.finalOutput?.trim() || 'Sure, let me check my calendar and get back to you.'
    } catch (error) {
      console.error('Error generating reply:', error)
      return 'I unfortunately can\'t access my calendar.'
    }
  }
}

// Agent for generating initial messages using Agent SDK
export class SendInitialMessageAgent {
  private agent: Agent

  constructor() {
    this.agent = new Agent({
      name: 'SendInitialMessageAgent',
      model: 'anthropic/claude-sonnet-4',
      modelSettings: {
        temperature: 0.7,
      },
      instructions: `You are an initial message generation agent. Generate a brief, natural initial message for a user to request help from the Pivotal scheduling bot.

Guidelines:
- Be natural and professional
- Keep it brief and to the point
- Make it clear what kind of help is needed
- Address the bot directly
- Generate only the message text, nothing else`,
    })
  }

  async generateInitialMessage(userName: string, goal: string): Promise<string> {
    if (!goal || goal.trim() === '') {
      return ''
    }

    const prompt = `You are ${userName}. Your goal is: ${goal}

Generate a brief initial message to request the Pivotal bot to help. Be natural and professional.

Generate only the message text, nothing else.`

    try {
      const result = await run(this.agent, prompt)
      return result.finalOutput?.trim() || `Hi, I'd like to ${goal.toLowerCase()}.`
    } catch (error) {
      console.error('Error generating initial message:', error)
      return `Hi, I'd like to ${goal.toLowerCase()}.`
    }
  }
}

// Agent for checking if a message is confirming a meeting suggestion
export class ConfirmationCheckAgent {
  private agent: Agent

  constructor() {
    this.agent = new Agent({
      name: 'ConfirmationCheckAgent',
      model: 'anthropic/claude-sonnet-4',
      modelSettings: {
        temperature: 0.1, // Low temperature for consistent classification
      },
      instructions: `You are a confirmation detection agent. Analyze messages to determine if they contain confirmation of meeting suggestions or time proposals.

      A confirmation message can be:
      - Brief responses like "Yes", "Sounds good", "Works for me", "Perfect", "Agreed", "That works", "Confirmed"
      - Longer messages that contain clear agreement to a specific meeting time, such as "Wednesday 10:00am-11:00am works perfectly for me"
      - Messages that accept a proposed meeting time even if they include additional context or information
      - Messages that say a specific time "works", is "perfect", they "agree", they "accept", etc.
      - Messages expressing gratitude for scheduling coordination like "Thank you for coordinating this!"
      - Messages showing forward-looking acceptance like "I'm looking forward to meeting with X on [day/time]"
      - Messages that acknowledge successful scheduling even without explicit "yes"

      NOT confirmations:
      - Questions about meeting times
      - Counter-proposals suggesting different times
      - Requests for clarification
      - Messages that don't reference a specific meeting time or proposal

      Respond with exactly "TRUE" for confirmations, "FALSE" otherwise.`,
    })
  }

  async isConfirming(messageText: string): Promise<boolean> {
    const prompt = `Analyze this message and determine if it contains confirmation or acceptance of a meeting suggestion or time proposal.

      Message: "${messageText}"

      Look for:
      - Explicit agreement to a specific meeting time
      - Phrases indicating acceptance like "works for me", "perfect", "sounds good", "I agree", "that works"
      - Confirmation of a proposed time slot even if surrounded by other text

      Response format:
      - If this message confirms or accepts a meeting time: Return "TRUE"
      - Otherwise: Return "FALSE"`

    try {
      const result = await run(this.agent, prompt)
      const response = result.finalOutput?.trim().toUpperCase()
      return response === 'TRUE'
    } catch (error) {
      console.error('Error checking confirmation with Agent:', error)
      return false
    }
  }
}

// Agent for extracting suggested meeting times from messages
export class TimeExtractionAgent {
  private agent: Agent

  constructor() {
    this.agent = new Agent({
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
  }

  async extractSuggestedTime(messageText: string): Promise<SimpleCalendarEvent | null> {
    const currentDate = new Date()
    const currentDateString = currentDate.toISOString().split('T')[0]
    const currentYear = currentDate.getFullYear()
    const currentMonth = currentDate.toLocaleString('en-US', { month: 'long' })

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
      const result = await run(this.agent, prompt)
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
}

// Create singleton instances for reuse
export const generateReplyAgent = new GenerateReplyAgent()
export const sendInitialMessageAgent = new SendInitialMessageAgent()
export const confirmationCheckAgent = new ConfirmationCheckAgent()
export const timeExtractionAgent = new TimeExtractionAgent()