// This script creates simple benchmark data for testing the scheduling agent

import { BaseScheduleUser } from './agents/user-agents'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile } from 'fs/promises'

async function createBenchmark(startTimeOffset: number, endTimeOffset: number, meetingLength: string) {
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
    
    // Only the first agent gets the scheduling goal
    let goal = ''
    if (index === 0) {
      const otherAgentNames = agentNames.filter((_, i) => i !== index)
      const startDateStr = startTime.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric' 
      })
      const endDateStr = endTime.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric' 
      })
      
      goal = `Schedule a ${meetingLength} meeting between ${startDateStr} and ${endDateStr} with ${otherAgentNames.join(', ')}`
    }
    
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

// Run the async function with default parameters
createBenchmark(3, 7, '1-hour').catch(console.error)