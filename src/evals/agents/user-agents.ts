// The base agent class contains a simple, working agent implementation

import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import type { UserProfile } from '../../tools/time_intersection'
import { local_api } from '../../shared/api-client'

// Initialize OpenRouter with API key from environment
const apiKey = process.env.PV_OPENROUTER_API_KEY
if (!apiKey) {
  throw new Error('PV_OPENROUTER_API_KEY environment variable is required')
}
const openrouter = createOpenRouter({
  apiKey,
})

const MODEL = 'google/gemini-2.5-flash'

// Util types
export interface SimpleCalendarEvent {
  start: Date
  end: Date
  summary: string
}

// Agent classes
export class BaseScheduleUser implements UserProfile {
  name: string
  calendar: SimpleCalendarEvent[]
  goal: string
  message_buffer: string[]

  constructor(name?: string, goal?: string, calendar?: SimpleCalendarEvent[]) {
    this.name = name || ''
    this.calendar = calendar || []
    this.goal = goal || ''
    this.message_buffer = []
  }

  receive(message: string): void {
    this.message_buffer.push(message)
  }

  empty_buffer(): void {
    this.message_buffer = []
  }

  async reply_buffer(): Promise<string> {
    // If no messages in buffer, nothing to reply to
    if (this.message_buffer.length === 0) {
      return ''
    }

    // Get the most recent message to reply to
    const latestMessage = this.message_buffer[this.message_buffer.length - 1]

    // Format calendar simply
    const calendarText = this.calendar.map(event => {
      const start = event.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      const end = event.end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      return `${start}-${end}: ${event.summary}`
    }).join(', ')

    // Simple prompt - only include goal if it's not empty
    const goalContext = this.goal && this.goal.trim() !== '' ? `Your goal is: ${this.goal}\n\n` : ''
    
    const prompt = `You are ${this.name}. ${goalContext}Your calendar: ${calendarText || 'Free all day'}

Message history: ${this.message_buffer.join(' | ')}

Respond naturally to: "${latestMessage}"

Be brief and professional.`

    try {
      const result = await generateText({
        model: openrouter(MODEL),
        prompt,
        maxTokens: 150,
        temperature: 0.8,
      })

      // RESETTING BUFFER AFTER REPLY
      //this.message_buffer = []
      
      return result.text.trim() || 'Sure, let me check my calendar and get back to you.'
    } catch (error) {
      console.error('Error generating response:', error)
      return 'I unfortunately can\'t access my calendar.'
    }
  }

  async send_initial_message(): Promise<string> {
    // Return empty string if no goal is set
    if (!this.goal || this.goal.trim() === '') {
      return ''
    }
    
    // Simple prompt for initial message
    const prompt = `You are ${this.name}. Your goal is: ${this.goal}

    Generate a brief initial message to request the Pivotal bot to help. Be natural and professional.`

    try {
      const result = await generateText({
        model: openrouter(MODEL),
        prompt,
        maxTokens: 100,
        temperature: 0.7,
      })
      
      return result.text.trim() || `Hi, I'd like to ${this.goal.toLowerCase()}.`
    } catch (error) {
      console.error('Error generating initial message:', error)
      return `Hi, I'd like to ${this.goal.toLowerCase()}.`
    }
  }

  eval_possibility(scheduled: SimpleCalendarEvent): boolean {
    // Check if the input event intersects with any existing calendar events
    for (const event of this.calendar) {
      // Two events intersect if one starts before the other ends
      if (scheduled.start < event.end && scheduled.end > event.start) {
        return false // Intersection found, not possible
      }
    }
    return true // No intersection, scheduling is possible
  }

  // Export to JSON-serializable format
  export(): any {
    return {
      name: this.name,
      goal: this.goal,
      calendar: this.calendar.map((event) => ({
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        summary: event.summary,
      })),
      message_buffer: this.message_buffer,
    }
  }

  // Create from exported data
  static import(data: any): BaseScheduleUser {
    const calendar = data.calendar.map((event: any) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      summary: event.summary,
    }))
    
    const user = new BaseScheduleUser(data.name, data.goal, calendar)
    user.message_buffer = data.message_buffer || []
    return user
  }
}