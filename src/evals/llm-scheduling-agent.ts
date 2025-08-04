import { GoogleGenerativeAI } from '@google/generative-ai'
import type { PersonProfile, TimeSlot } from './scheduling-eval'
import { evaluateMeetingTime } from './scheduling-eval'
import { generateRandomProfiles } from './scheduling-benchmark'

// Initialize Gemini
const genAI = new GoogleGenerativeAI('AIzaSyDg-FRPPJEpDBTrZ29REJ-YmX6JTy_nE0k')
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' })

// Format calendar for LLM (hide utility values)
function formatCalendarForLLM(profile: PersonProfile): string {
  const events = profile.calendar.map(event =>
    `  - ${event.start}-${event.end}: ${event.description}`,
  ).join('\n')

  return `${profile.name}:\n${events || '  - No events scheduled'}`
}

// LLM agent that picks meeting times
export async function llmSchedulingAgent(profiles: PersonProfile[]): Promise<TimeSlot> {
  // Format all calendars
  const calendarsText = profiles.map(formatCalendarForLLM).join('\n\n')

  const prompt = `Find the best 1-hour meeting time for these 5 people on Tuesday.

${calendarsText}

Rules:
1. NEVER schedule during: flights, medical appointments, picking up children, emergencies
2. AVOID scheduling during: client calls, important meetings
3. OK to schedule during: focus time, work blocks, lunch (if needed)

Check each hour from 8:00 to 17:00. Pick the time where the MOST people are free.
If tied, pick the time with the least important conflicts.

Reply with just the start time: HH:MM`

  try {
    const result = await model.generateContent(prompt)
    const response = result.response.text().trim()

    // Parse the response to extract time
    const timeMatch = response.match(/(\d{1,2}):(\d{2})/)
    if (!timeMatch) {
      console.error('Failed to parse time from LLM response:', response)
      return { start: '10:00', end: '11:00' } // Fallback
    }

    const hours = parseInt(timeMatch[1])
    const minutes = parseInt(timeMatch[2])
    const start = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
    const endHour = hours + 1
    const end = `${endHour.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`

    return { start, end }
  } catch (error) {
    console.error('Error calling Gemini:', error)
    return { start: '10:00', end: '11:00' } // Fallback
  }
}

// Run evaluation on N test cases
export async function evaluateLLMScheduler(numCases: number = 10) {
  console.log(`Evaluating LLM scheduler on ${numCases} test cases...\n`)

  const results: number[] = []
  let optimalCount = 0

  for (let i = 0; i < numCases; i++) {
    // Generate random test case
    const profiles = generateRandomProfiles(5)

    // Get LLM's suggestion
    const suggestedTime = await llmSchedulingAgent(profiles)

    // Evaluate it
    const evaluation = evaluateMeetingTime(profiles, suggestedTime)
    results.push(evaluation.percentile)

    if (evaluation.totalUtility === evaluation.maxPossibleUtility) {
      optimalCount++
    }

    console.log(`Case ${i + 1}: ${suggestedTime.start}-${suggestedTime.end} → ${evaluation.percentile.toFixed(1)}% percentile`)

    // Add delay to avoid rate limiting (10 requests per minute limit)
    if (i < numCases - 1) {
      await new Promise(resolve => setTimeout(resolve, 6000)) // 6 seconds between requests
    }
  }

  // Calculate statistics
  const avgPercentile = results.reduce((sum, p) => sum + p, 0) / results.length
  const minPercentile = Math.min(...results)
  const maxPercentile = Math.max(...results)

  console.log('\n' + '='.repeat(50))
  console.log('LLM Scheduling Results:')
  console.log('='.repeat(50))
  console.log(`Average percentile: ${avgPercentile.toFixed(1)}%`)
  console.log(`Best case: ${maxPercentile.toFixed(1)}%`)
  console.log(`Worst case: ${minPercentile.toFixed(1)}%`)
  console.log(`Times optimal found: ${optimalCount} (${(optimalCount / numCases * 100).toFixed(1)}%)`)
  console.log('\nDistribution:')
  console.log(`  ≥90th percentile: ${results.filter(p => p >= 90).length}`)
  console.log(`  ≥75th percentile: ${results.filter(p => p >= 75).length}`)
  console.log(`  ≥50th percentile: ${results.filter(p => p >= 50).length}`)
  console.log(`  <25th percentile: ${results.filter(p => p < 25).length}`)
}

// Test on a single example
export async function testSingleExample() {
  const profiles = generateRandomProfiles(5)

  console.log('Test case calendars:')
  profiles.forEach(p => console.log('\n' + formatCalendarForLLM(p)))

  const suggestedTime = await llmSchedulingAgent(profiles)
  const evaluation = evaluateMeetingTime(profiles, suggestedTime)

  console.log('\n' + '='.repeat(50))
  console.log(`LLM suggested: ${suggestedTime.start}-${suggestedTime.end}`)
  console.log(`Percentile: ${evaluation.percentile.toFixed(1)}%`)
  console.log(`Utility: ${evaluation.totalUtility} (max: ${evaluation.maxPossibleUtility})`)
  console.log('\nIndividual impacts:')
  evaluation.individualScores.forEach(score => {
    const impact = score.conflictingEvent
      ? `conflicts with "${score.conflictingEvent.description}"`
      : 'is free'
    console.log(`  ${score.person}: ${impact} (utility: ${score.utility})`)
  })
}

// Run the evaluation
if (import.meta.url === `file://${process.argv[1]}`) {
  const numCases = parseInt(process.argv[2] || '10')
  evaluateLLMScheduler(numCases).catch(console.error)
}
