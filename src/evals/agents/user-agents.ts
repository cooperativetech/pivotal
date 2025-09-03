// The base agent class contains a simple, working agent implementation

import type { UserProfile } from '../../tools/time_intersection'

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

  reply_buffer(): string {
    // TODO: Implement reply generation logic
    return ''
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