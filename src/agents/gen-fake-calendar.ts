import { z } from 'zod'

import { Agent, run, tool } from './agent-sdk'
import { CalendarEvent } from '@shared/api-types'

const CalendarOutput = z.strictObject({
  events: z.array(CalendarEvent).describe('Array of calendar events with ISO timestamps and timezone offsets'),
})

// Create a tool for generating calendar events with strict validation
const generateCalendarEvents = tool({
  name: 'generateCalendarEvents',
  description: 'Generate realistic calendar events for a person based on their profession and industry',
  parameters: CalendarOutput,
  strict: true,
  execute: (output) => output,
})

const fakeCalendarAgent = new Agent({
  name: 'fakeCalendarAgent',
  model: 'anthropic/claude-sonnet-4',
  toolUseBehavior: { stopAtToolNames: ['generateCalendarEvents'] },
  modelSettings: {
    temperature: 1, // Increase temperature for calendar diversity
    toolChoice: 'required',
  },
  tools: [generateCalendarEvents],
  outputType: CalendarOutput,
  instructions: `You are a calendar event generator. Generate realistic calendar events for a person's work schedule.

Guidelines:
- Generate events mostly on weekdays, during work hours in the user's timezone (work hours depend on role / industry)
- Don't over-schedule - aim for maximum 60-70% calendar density during work hours, and much less calendar density on weekends, or depending on role / industry
- Make sure all timestamps are in ISO 8601 format with the correct timezone offset
- Events should be relevant to the person's profession and industry
- Include a mix of meetings, work blocks, and other professional activities

Use the generateCalendarEvents tool with your generated events. The tool expects an array of calendar events with proper ISO timestamps and timezone offsets.`,
})

/**
 * Generate realistic fake calendar events for a user
 * Used for testing and development when real calendar data isn't available
 */
export async function genFakeCalendar(
  timezone: string,
  startTime: Date,
  endTime: Date,
): Promise<CalendarEvent[]> {
  const adjectives = [
    'experienced', 'innovative', 'strategic', 'creative', 'meticulous',
    'quirky', 'maverick', 'pragmatic', 'visionary', 'fearless',
  ]

  const professions = [
    'software engineer', 'product manager', 'chef', 'electrician', 'nurse',
    'teacher', 'artist', 'farmer', 'pilot', 'barista',
    'firefighter', 'veterinarian', 'podcast host', 'mechanic', 'therapist',
    'musician', 'real estate agent', 'park ranger', 'tattoo artist', 'marine biologist',
    'truck driver', 'yoga instructor', 'locksmith', 'mortician', 'puppeteer',
    'wind turbine technician', 'cheese maker', 'escape room designer', 'snake milker',
  ]

  const industries = [
    'technology', 'healthcare', 'construction', 'agriculture', 'education',
    'restaurants', 'renewable energy', 'entertainment', 'transportation', 'emergency services',
    'manufacturing', 'non-profits', 'fitness & wellness', 'funeral services', 'space exploration',
    'gaming', 'pet care', 'theme parks', 'paranormal investigation', 'artisanal crafts',
  ]

  // Randomly select one from each category
  const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const randomProfession = professions[Math.floor(Math.random() * professions.length)]
  const randomIndustry = industries[Math.floor(Math.random() * industries.length)]

  const userPrompt = `Generate realistic calendar events in timezone ${timezone}.

Date range: ${startTime.toISOString()} to ${endTime.toISOString()}

The person is an ${randomAdjective} ${randomProfession} working in ${randomIndustry}. They should have a professional schedule with a variety of meetings and work blocks relevant to their role and industry.`

  try {
    const result = await run(fakeCalendarAgent, userPrompt)
    
    if (!result.finalOutput) {
      throw new Error('No output generated')
    }

    return result.finalOutput.events
  } catch (error) {
    console.error('Error generating fake calendar events:', error)
    return []
  }
}
