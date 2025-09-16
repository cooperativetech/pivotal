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

export interface BaseScheduleUserData {
  name: string
  goal: string
  calendar: {
    start: string
    end: string
    summary: string
  }[]
  messageBuffer: string[]
  history: HistoryMessage[]
}

export interface BenchmarkData {
  startTime: string
  startTimeOffset: number
  endTime: string
  endTimeOffset: number
  meetingLength: number
  nAgents: number
}

export interface BenchmarkFileData {
  benchmark: BenchmarkData
  agents: BaseScheduleUserData[]
}

export interface EvaluationSummary {
  totalAgents: number
  confirmedCount: number
  hasSuggestedEvent: boolean
  allCanAttend: boolean
}

export interface EvaluationResults {
  suggestedEvent: {
    start: string
    end: string
    summary: string
  } | null
  confirmedAgents: string[]
  allAgentsConfirmed: boolean
  canAttend: Record<string, boolean>
  maxSharedFreeTime: number
  evaluationSummary: EvaluationSummary
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
    const reply = await generateReplyAgent.generateReply(this.name, this.goal, this.calendar, this.messageBuffer, this.history)

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
    return await sendInitialMessageAgent.generateInitialMessage(this.name, this.goal)
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
    const calendar = data.calendar.map((event) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      summary: event.summary,
    }))

    const user = new BaseScheduleUser(data.name, data.goal, calendar)
    user.messageBuffer = data.messageBuffer || []
    user.history = data.history || []
    return user
  }
}
