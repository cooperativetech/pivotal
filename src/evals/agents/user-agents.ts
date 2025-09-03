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
}