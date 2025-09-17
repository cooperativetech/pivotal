// The base agent class contains a simple, working agent implementation

import type { UserProfile } from '../tools/time_intersection'
import { generateReply, generateInitialMessage } from '../agents/evals'
import { ScheduleSimData, type BaseScheduleUserData, type HistoryMessage } from './utils'

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
  messageBuffer: string[]
  history: HistoryMessage[]

  constructor(name?: string, goal?: string, calendar?: SimpleCalendarEvent[]) {
    this.name = name || ''
    this.calendar = calendar || []
    this.goal = goal || ''
    this.messageBuffer = []
    this.history = []
  }

  receive(message: string): void {
    this.messageBuffer.push(message)
  }

  emptyBuffer(): void {
    this.messageBuffer = []
  }

  async replyBuffer(): Promise<string> {
    if (this.messageBuffer.length === 0) {
      return ''
    }

    // Generate reply using both message buffer and history context
    const reply = await generateReply(this.name, this.goal, this.calendar, this.messageBuffer, this.history)

    // Move messages from buffer to history as bot messages
    for (const message of this.messageBuffer) {
      this.history.push({ sender: 'bot', message })
    }

    // Clear the buffer after moving to history
    this.messageBuffer = []

    // Save the reply to history
    if (reply) {
      this.history.push({ sender: 'user', message: reply })
    }

    return reply
  }

  async sendInitialMessage(): Promise<string> {
    return await generateInitialMessage(this.name, this.goal)
  }

  evalPossibility(scheduled: SimpleCalendarEvent): boolean {
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
          hour12: true,
          timeZone: 'America/New_York',
        })
        const eventEndTime = event.end.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/New_York',
        })
        console.log(`    Conflict: ${this.name} has "${event.summary}" from ${eventStartTime} to ${eventEndTime}`)
        return false // Intersection found, not possible
      }
    }
    return true // No intersection, scheduling is possible
  }

  // Export to JSON-serializable format
  export(): BaseScheduleUserData {
    return {
      name: this.name,
      goal: this.goal,
      calendar: this.calendar.map((event) => ({
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        summary: event.summary,
      })),
      messageBuffer: this.messageBuffer,
      history: this.history,
    }
  }

  // Create from exported data
  static import(data: BaseScheduleUserData): BaseScheduleUser {
    // Validate the data structure with Zod (defensive validation at boundary)
    const validatedData = ScheduleSimData.parse(data)

    const calendar = validatedData.calendar.map((event) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      summary: event.summary,
    }))

    const user = new BaseScheduleUser(validatedData.name, validatedData.goal, calendar)
    user.messageBuffer = validatedData.messageBuffer || []
    user.history = validatedData.history || []
    return user
  }
}
