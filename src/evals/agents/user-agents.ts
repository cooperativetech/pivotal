// The base agent class contains a simple, working agent implementation

import type { UserProfile } from '../../tools/time_intersection'
import { generateReplyAgent, sendInitialMessageAgent } from './util-agents'

// Util types
export interface SimpleCalendarEvent {
  start: Date
  end: Date
  summary: string
}

export interface HistoryMessage {
  sender: 'bot' | 'user'
  message: string
}

// Agent classes
export class BaseScheduleUser implements UserProfile {
  name: string
  calendar: SimpleCalendarEvent[]
  goal: string
  message_buffer: string[]
  history: HistoryMessage[]

  constructor(name?: string, goal?: string, calendar?: SimpleCalendarEvent[]) {
    this.name = name || ''
    this.calendar = calendar || []
    this.goal = goal || ''
    this.message_buffer = []
    this.history = []
  }

  receive(message: string): void {
    this.message_buffer.push(message)
  }

  empty_buffer(): void {
    this.message_buffer = []
  }

  async reply_buffer(): Promise<string> {
    if (this.message_buffer.length === 0) {
      return ''
    }

    // Generate reply using both message buffer and history context
    const reply = await generateReplyAgent.generateReply(this.name, this.goal, this.calendar, this.message_buffer, this.history)
    
    // Move messages from buffer to history as bot messages
    for (const message of this.message_buffer) {
      this.history.push({ sender: 'bot', message })
    }
    
    // Clear the buffer after moving to history
    this.message_buffer = []
    
    // Save the reply to history
    if (reply) {
      this.history.push({ sender: 'user', message: reply })
    }
    
    return reply
  }

  async send_initial_message(): Promise<string> {
    return await sendInitialMessageAgent.generateInitialMessage(this.name, this.goal)
  }

  eval_possibility(scheduled: SimpleCalendarEvent): boolean {
    // Check if the input event intersects with any existing calendar events
    for (const event of this.calendar) {
      // Two events intersect if one starts before the other ends
      if (scheduled.start < event.end && scheduled.end > event.start) {
        // Log the conflicting meeting details
        const eventStartTime = event.start.toLocaleString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })
        const eventEndTime = event.end.toLocaleTimeString('en-US', { 
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })
        console.log(`    Conflict: ${this.name} has "${event.summary}" from ${eventStartTime} to ${eventEndTime}`)
        return false // Intersection found, not possible
      }
    }
    return true // No intersection, scheduling is possible
  }

  // Export to JSON-serializable format
  export(): Record<string, unknown> {
    return {
      name: this.name,
      goal: this.goal,
      calendar: this.calendar.map((event) => ({
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        summary: event.summary,
      })),
      message_buffer: this.message_buffer,
      history: this.history,
    }
  }

  // Create from exported data
  static import(data: Record<string, unknown>): BaseScheduleUser {
    const calendar = (data.calendar as Record<string, unknown>[]).map((event: Record<string, unknown>) => ({
      start: new Date(event.start as string),
      end: new Date(event.end as string),
      summary: event.summary as string,
    }))

    const user = new BaseScheduleUser(data.name as string, data.goal as string, calendar)
    user.message_buffer = (data.message_buffer as string[]) || []
    user.history = (data.history as HistoryMessage[]) || []
    return user
  }
}
