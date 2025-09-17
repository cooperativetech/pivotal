// The base agent class contains a simple, working agent implementation

import { z } from 'zod'
import type { UserProfile } from '../tools/time_intersection'
import { generateReply, generateInitialMessage } from '../agents/evals'

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

// Zod schemas for runtime validation
const SerializedCalendarEventSchema = z.strictObject({
  start: z.string(),
  end: z.string(),
  summary: z.string(),
})

const HistoryMessageSchema = z.strictObject({
  sender: z.enum(['bot', 'user']),
  message: z.string(),
})

export const ScheduleSimDataSchema = z.strictObject({
  name: z.string(),
  goal: z.string(),
  calendar: z.array(SerializedCalendarEventSchema),
  messageBuffer: z.array(z.string()),
  history: z.array(HistoryMessageSchema),
})

export const BenchmarkDataSchema = z.strictObject({
  startTime: z.string(),
  startTimeOffset: z.number(),
  endTime: z.string(),
  endTimeOffset: z.number(),
  meetingLength: z.number(),
  nSimUsers: z.number(),
})

export const BenchmarkFileDataSchema = z.strictObject({
  benchmark: BenchmarkDataSchema,
  agents: z.array(ScheduleSimDataSchema),
})

const EvaluationSummarySchema = z.strictObject({
  totalSimUsers: z.number(),
  confirmedCount: z.number(),
  hasSuggestedEvent: z.boolean(),
  allCanAttend: z.boolean(),
})

export const EvaluationResultsSchema = z.strictObject({
  suggestedEvent: z.strictObject({
    start: z.string(),
    end: z.string(),
    summary: z.string(),
  }).nullable(),
  confirmedSimUsers: z.array(z.string()),
  allSimUsersConfirmed: z.boolean(),
  canAttend: z.record(z.boolean()),
  maxSharedFreeTime: z.number(),
  evaluationSummary: EvaluationSummarySchema,
})

export const SavedEvaluationResultsSchema = EvaluationResultsSchema.extend({
  evalTimestamp: z.string(),
  benchmarkFile: z.string(),
  benchmarkType: z.string(),
  genTimestamp: z.string(),
})

// Type exports inferred from Zod schemas
export type BaseScheduleUserData = z.infer<typeof ScheduleSimDataSchema>
export type BenchmarkData = z.infer<typeof BenchmarkDataSchema>
export type BenchmarkFileData = z.infer<typeof BenchmarkFileDataSchema>
export type EvaluationSummary = z.infer<typeof EvaluationSummarySchema>
export type EvaluationResults = z.infer<typeof EvaluationResultsSchema>
export type SavedEvaluationResults = z.infer<typeof SavedEvaluationResultsSchema>

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
    const validatedData = ScheduleSimDataSchema.parse(data)

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
