// This script creates simple benchmark data for testing the scheduling agent

import { BaseScheduleUser } from './agents/user-agents'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile } from 'fs/promises'

async function createBenchmark(startTimeOffset: number, endTimeOffset: number) {
  // Define date range for fake calendars using offsets from January 1, 2025
  const referenceDate = new Date('2025-01-01T00:00:00Z')
  const startTime = new Date(referenceDate)
  startTime.setDate(referenceDate.getDate() + startTimeOffset)
  const endTime = new Date(referenceDate)
  endTime.setDate(referenceDate.getDate() + endTimeOffset)

  // Agent names
  const agentNames = ['Alice', 'Bob']

  // Generate fake calendars for all agents
  const calendarEvents = await Promise.all(
    agentNames.map(() => genFakeCalendar('America/New_York', startTime, endTime)),
  )

  // Create agents list
  const agents: BaseScheduleUser[] = agentNames.map((name, index) => {
    const calendar = convertCalendarEventsToUserProfile(calendarEvents[index])
    const goal = index === 0 ? 'Schedule a meeting' : ''
    return new BaseScheduleUser(name, goal, calendar)
  })

  console.log('Created agents:')
  agents.forEach((agent) => console.log(`${agent.name}: ${agent.calendar.length} events`))

  // Export agents to JSON file
  const exportedAgents: Record<string, unknown>[] = agents.map((agent) => agent.export())
  await writeFile('./src/evals/data/simple-benchmark.json', JSON.stringify(exportedAgents, null, 2))
  console.log('Agents saved to simple-benchmark.json')

  return agents
}

// Run the async function with default offsets (equivalent to the previous behavior)
createBenchmark(3, 7).catch(console.error)