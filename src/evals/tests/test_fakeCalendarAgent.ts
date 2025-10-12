import { z } from 'zod'
import { Agent, run } from '../../agents/agent-sdk'
// import { CalendarEvent } from '@shared/api-types'

// // Create the original strict agent
// const fakeCalendarAgent = new Agent({
//   name: 'fakeCalendarAgent',
//   model: 'anthropic/claude-sonnet-4',
//   modelSettings: {
//     temperature: 1,
//   },
//   outputType: z.strictObject({
//     items: z.array(CalendarEvent),
//   }),
//   instructions: `Generate calendar events for a person's work schedule in JSON format.

// Guidelines:
// - Generate events mostly on weekdays, during work hours in the user's timezone (work hours depend on role / industry)
// - Don't over-schedule - aim for maximum 60-70% calendar density during work hours, and much less calendar density on weekends, or depending on role / industry

// Return ONLY a JSON array of objects with this structure:
// [
//   {
//     "start": "2024-01-15T09:00:00-08:00",
//     "end": "2024-01-15T09:30:00-08:00",
//     "summary": "Team Standup"
//   }
// ]

// Make sure all timestamps are in ISO 8601 format with the correct timezone offset.`,
// })

// Create a loose agent to see raw output without strict validation
const looseFakeCalendarAgent = new Agent({
  name: 'looseFakeCalendarAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    temperature: 1,
  },
  outputType: z.object({
    items: z.array(z.any()), // Allow any array items to see what we're getting
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

async function testFakeCalendarAgent() {
  const startTime = new Date()
  startTime.setDate(startTime.getDate() + 3)
  const endTime = new Date()
  endTime.setDate(startTime.getDate() + 1)

  const userPrompt = `Generate realistic calendar events in timezone America/New_York.

Date range: ${startTime.toISOString()} to ${endTime.toISOString()}

The person is an experienced software engineer working in technology. They should have a professional schedule with a variety of meetings and work blocks relevant to their role and industry.`

  console.log('Testing fakeCalendarAgent with prompt:')
  console.log(userPrompt)
  console.log('\n---\n')

  try {
    console.log('Running loose agent to see raw output...')
    const result = await run(looseFakeCalendarAgent, userPrompt)
    console.log('Raw result:')
    console.log(JSON.stringify(result, null, 2))
    if (result.finalOutput) {
      console.log('\nFinal output:')
      console.log(JSON.stringify(result.finalOutput, null, 2))
      console.log(`\nGenerated ${result.finalOutput.items?.length || 0} calendar events`)
    } else {
      console.log('\nNo final output generated')
    }
  } catch (error) {
    console.error('Error:', error)
    if (error instanceof Error) {
      console.error('Error details:', error.message)
    }
  }
}

// Run the test
testFakeCalendarAgent().catch(console.error)
