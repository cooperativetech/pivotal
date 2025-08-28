import { z } from 'zod'

import { Agent, run } from './agent-sdk'
import { CalendarEvent } from '@shared/api-types'

const fakeCalendarAgent = new Agent({
  name: 'fakeCalendarAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    temperature: 1, // Increase temperature for calendar diversity
  },
  outputType: z.strictObject({
    items: z.array(CalendarEvent),
  }),
  instructions: `Generate calendar events for a person's work schedule in JSON format.

Guidelines:
- Generate events mostly on weekdays, during work hours in the user's timezone (work hours depend on role / industry)
- Don't over-schedule - aim for maximum 60-70% calendar density during work hours, and much less calendar density on weekends, or depending on role / industry

Return ONLY a JSON array of objects with this structure:
[
  {
    "start": "2024-01-15T09:00:00-08:00",
    "end": "2024-01-15T09:30:00-08:00",
    "summary": "Team Standup"
  }
]

Make sure all timestamps are in ISO 8601 format with the correct timezone offset.`,
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
      throw new Error('No finalOutput generated')
    }
    return result.finalOutput.items
  } catch (error) {
    console.error('Error generating fake calendar events:', error)
  }

  return []
}
