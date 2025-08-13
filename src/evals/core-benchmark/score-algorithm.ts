import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { PersonProfile, TimeSlot } from './generate-benchmark-data'

// What algorithms actually see - calendar + separate raw text input
export interface PersonInput {
  name: string
  calendar?: Array<{    // Optional - person might not share calendar
    start: string      // "09:00"
    end: string        // "10:00"
    title: string      // "Team sync"
    description?: string  // Optional calendar event description
  }>
}

interface BenchmarkTestCase {
  id: number
  profiles: PersonProfile[]
  aggregateRawText?: string  // Conversation history from all participants
  utilityDistribution: {
    timeSlot: TimeSlot
    totalUtility: number
  }[]
  optimalSlots: TimeSlot[]
  optimalUtility: number
}

interface AlgorithmResult {
  testCaseId: number
  suggestedSlot: TimeSlot
  achievedUtility: number
  optimalUtility: number
  utilityRatio: number
  percentile: number
  isOptimal: boolean
}

interface ScoringResults {
  algorithmName: string
  totalCases: number
  results: AlgorithmResult[]
  summary: {
    averagePercentile: number
    averageUtilityRatio: number
    optimalCount: number
    optimalRate: number
    percentileDistribution: {
      top10: number    // >= 90th percentile
      top25: number    // >= 75th percentile
      top50: number    // >= 50th percentile
      bottom25: number // < 25th percentile
    }
  }
}

// Convert internal profiles to public format (hide utilities and event types)
function toPublicProfiles(profiles: PersonProfile[], dataAvailability: DataAvailabilityConfig): PersonInput[] {
  return profiles.map((profile) => {
    // Decide whether to include calendar based on probability
    const includeCalendar = Math.random() < dataAvailability.calendarProbability

    return {
      name: profile.name,
      calendar: includeCalendar && profile.calendar.length > 0 ? profile.calendar.map((event) => {
        // Extract time from Google Calendar format
        let start = '09:00'
        let end = '10:00'
        
        if (event.start.dateTime && event.end.dateTime) {
          const startDate = new Date(event.start.dateTime)
          const endDate = new Date(event.end.dateTime)
          start = `${startDate.getHours().toString().padStart(2, '0')}:${startDate.getMinutes().toString().padStart(2, '0')}`
          end = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`
        }
        
        return {
          start,
          end,
          title: event.summary || 'Busy',
        }
      }) : undefined,
    }
  })
}

export interface DataAvailabilityConfig {
  calendarProbability: number  // 0-1, probability of including calendar
}

export async function scoreAlgorithm(
  algorithmName: string,
  algorithm: (inputs: PersonInput[], aggregateRawText?: string) => TimeSlot | Promise<TimeSlot>,
  benchmarkDataFile: string,
  dataAvailability: DataAvailabilityConfig = { calendarProbability: 1.0 },
): Promise<ScoringResults> {
  // Check if file exists in data directory first, then current directory
  const dataDir = join(import.meta.dirname, '..', 'data')
  let filepath = join(dataDir, benchmarkDataFile)

  if (!existsSync(filepath)) {
    // Try without data directory
    filepath = benchmarkDataFile
    if (!existsSync(filepath)) {
      throw new Error(`Benchmark data file not found: ${benchmarkDataFile} (looked in data/ and current directory)`)
    }
  }

  // Load benchmark data
  console.log(`Loading benchmark data from ${filepath}...`)
  const testCases: BenchmarkTestCase[] = JSON.parse(readFileSync(filepath, 'utf-8')) as BenchmarkTestCase[]
  console.log(`Loaded ${testCases.length} test cases`)

  console.log(`\nScoring algorithm: ${algorithmName}`)

  const results: AlgorithmResult[] = []

  for (const testCase of testCases) {
    // Convert to public format and run algorithm
    const publicProfiles = toPublicProfiles(testCase.profiles, dataAvailability)

    let suggestedSlot: TimeSlot
    try {
      suggestedSlot = await algorithm(publicProfiles, testCase.aggregateRawText)
    } catch (error) {
      console.error('Algorithm threw error:', error)
      throw error
    }

    // Validate the suggested slot
    if (!suggestedSlot || typeof suggestedSlot !== 'object') {
      throw new Error(`Algorithm returned invalid result: ${JSON.stringify(suggestedSlot)}`)
    }

    if (!suggestedSlot.start || !suggestedSlot.end) {
      throw new Error(`Algorithm suggested invalid slot: start=${suggestedSlot.start}, end=${suggestedSlot.end}`)
    }

    // Find the utility for this slot
    const slotData = testCase.utilityDistribution.find(
      (d) => d.timeSlot.start === suggestedSlot.start && d.timeSlot.end === suggestedSlot.end,
    )

    let achievedUtility: number
    let percentile: number
    let isOptimal: boolean

    if (!slotData) {
      console.warn(`Algorithm suggested non-existent slot: ${suggestedSlot.start}-${suggestedSlot.end}`)
      console.warn('Assigning 0% percentile score')

      // Invalid slot gets worst possible score
      achievedUtility = testCase.utilityDistribution[0].totalUtility // Just for ratio calculation
      percentile = 0
      isOptimal = false
    } else {
      achievedUtility = slotData.totalUtility

      // Calculate percentile (what % of slots are worse)
      const worseCount = testCase.utilityDistribution.filter(
        (d) => d.totalUtility < achievedUtility,
      ).length
      percentile = (worseCount / testCase.utilityDistribution.length) * 100

      // Check if optimal
      isOptimal = testCase.optimalSlots.some(
        (slot) => slot.start === suggestedSlot.start && slot.end === suggestedSlot.end,
      )
    }

    results.push({
      testCaseId: testCase.id,
      suggestedSlot,
      achievedUtility,
      optimalUtility: testCase.optimalUtility,
      utilityRatio: achievedUtility / testCase.optimalUtility,
      percentile: Math.round(percentile * 100) / 100,
      isOptimal,
    })
  }

  // Calculate summary statistics
  const summary = {
    averagePercentile: results.reduce((sum, r) => sum + r.percentile, 0) / results.length,
    averageUtilityRatio: results.reduce((sum, r) => sum + r.utilityRatio, 0) / results.length,
    optimalCount: results.filter((r) => r.isOptimal).length,
    optimalRate: results.filter((r) => r.isOptimal).length / results.length,
    percentileDistribution: {
      top10: results.filter((r) => r.percentile >= 90).length,
      top25: results.filter((r) => r.percentile >= 75).length,
      top50: results.filter((r) => r.percentile >= 50).length,
      bottom25: results.filter((r) => r.percentile < 25).length,
    },
  }

  return {
    algorithmName,
    totalCases: testCases.length,
    results,
    summary,
  }
}

export function printScoringResults(results: ScoringResults): void {
  console.log('\n' + '='.repeat(60))
  console.log('EVALUATION RESULTS')
  console.log('='.repeat(60))
  console.log(`Average Percentile: ${results.summary.averagePercentile.toFixed(1)}%`)
  console.log('='.repeat(60))
}

// Example usage for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('This file exports scoring functions for evaluating scheduling algorithms.')
  console.log('\nUsage:')
  console.log('  import { scoreAlgorithm, printScoringResults } from \'./score-algorithm\'')
  console.log('  const results = scoreAlgorithm(\'My Algorithm\', myAlgorithm, \'benchmark-data-100-cases.json\')')
  console.log('  printScoringResults(results)')
  console.log('\nFirst generate benchmark data:')
  console.log('  npx tsx generate-benchmark-data.ts [num-cases]')
}