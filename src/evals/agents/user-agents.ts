// The base agent class contains a simple, working agent implementation

import type { UserProfile } from '../../tools/time_intersection'
import { generateReplyAgent, sendInitialMessageAgent } from './util-agents'

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
    return await generateReplyAgent.generateReply(this.name, this.goal, this.calendar, this.message_buffer)
  }

  async send_initial_message(): Promise<string> {
    return await sendInitialMessageAgent.generateInitialMessage(this.name, this.goal)
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
    return user
  }
}
