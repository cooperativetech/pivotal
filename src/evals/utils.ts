import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { z } from 'zod'
import type { SimpleCalendarEvent } from './sim-users'

// Zod schemas for runtime validation
const SerializedCalendarEvent = z.strictObject({
  start: z.string(),
  end: z.string(),
  summary: z.string(),
})

const HistoryMessage = z.strictObject({
  sender: z.enum(['bot', 'user']),
  message: z.string(),
})

export const ScheduleSimData = z.strictObject({
  name: z.string(),
  goal: z.string(),
  calendar: z.array(SerializedCalendarEvent),
  messageBuffer: z.array(z.string()),
  history: z.array(HistoryMessage),
})

export const BenchmarkData = z.strictObject({
  startTime: z.string(),
  startTimeOffset: z.number(),
  endTime: z.string(),
  endTimeOffset: z.number(),
  meetingLength: z.number(),
  nSimUsers: z.number(),
})

export const BenchmarkFileData = z.strictObject({
  benchmark: BenchmarkData,
  agents: z.array(ScheduleSimData),
})

const EvaluationSummary = z.strictObject({
  totalSimUsers: z.number(),
  confirmedCount: z.number(),
  hasSuggestedEvent: z.boolean(),
  allCanAttend: z.boolean(),
})

export const EvaluationResults = z.strictObject({
  suggestedEvent: z.strictObject({
    start: z.string(),
    end: z.string(),
    summary: z.string(),
  }).nullable(),
  confirmedSimUsers: z.array(z.string()),
  allSimUsersConfirmed: z.boolean(),
  canAttend: z.record(z.boolean()),
  maxSharedFreeTime: z.number(),
  evaluationSummary: EvaluationSummary,
})

export const SavedEvaluationResults = EvaluationResults.extend({
  evalTimestamp: z.string(),
  benchmarkFile: z.string(),
  benchmarkType: z.string(),
  genTimestamp: z.string(),
})

// Type exports inferred from Zod schemas
export type BaseScheduleUserData = z.infer<typeof ScheduleSimData>
export type BenchmarkData = z.infer<typeof BenchmarkData>
export type BenchmarkFileData = z.infer<typeof BenchmarkFileData>
export type EvaluationSummary = z.infer<typeof EvaluationSummary>
export type EvaluationResults = z.infer<typeof EvaluationResults>
export type SavedEvaluationResults = z.infer<typeof SavedEvaluationResults>

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function formatTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')

  return `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`
}

// Find the benchmark file in the data directory or subdirectories
export function findBenchmarkFile(filename: string): string {
  // Remove .json extension if provided
  const baseFilename = filename.replace(/\.json$/, '')

  // Try direct file path first
  const directPath = join(__dirname, 'data', `${baseFilename}.json`)
  if (existsSync(directPath)) {
    return directPath
  }

  // Try looking in subdirectory (for organized benchmark files)
  // Extract folder name pattern from filename
  const folderMatch = baseFilename.match(/^(benchmark_\d+(?:simusers|agents)_[\d-]+start_[\d-]+end_\d+min)/)
  if (folderMatch) {
    const folderName = folderMatch[1]
    const subDirPath = join(__dirname, 'data', folderName, `${baseFilename}.json`)
    if (existsSync(subDirPath)) {
      return subDirPath
    }
  }

  throw new Error(`Benchmark file not found: ${filename}. Tried:\n  - ${directPath}\n  - ${join(__dirname, 'data', folderMatch?.[1] || 'unknown', `${baseFilename}.json`)}`)
}

// Save evaluation results to JSON file
export function saveEvaluationResults(
  benchmarkFileName: string,
  resultsData: EvaluationResults,
): SavedEvaluationResults {
  // Validate results data structure with Zod (defensive validation at boundary)
  const validatedResults = EvaluationResults.parse(resultsData)
  const evalTimestamp = formatTimestamp()

  // Remove .json extension from benchmark filename if present
  const baseFileName = benchmarkFileName.replace(/\.json$/, '')

  // Extract benchmark type and gen timestamp from filename
  // Format: benchmark_2simusers_1start_2end_60min_gen20250915121553773 (or with hyphens: benchmark_2simusers_1-5start_2end_60min)
  const genMatch = baseFileName.match(/^(.+)_(gen\d{17})$/)

  if (!genMatch) {
    throw new Error(`Invalid benchmark filename format: ${baseFileName}. Expected format: benchmark_type_gen<timestamp>`)
  }

  const [, benchmarkType, genTimestamp] = genMatch

  // Create 3-level nested folder structure: results/benchmark_type/gen_timestamp/eval_timestamp/
  const benchmarkTypePath = join(__dirname, 'results', benchmarkType)
  const genTimestampPath = join(benchmarkTypePath, genTimestamp)
  const evalFolderName = `eval${evalTimestamp}`
  const evalFolderPath = join(genTimestampPath, evalFolderName)

  // Create folder if it doesn't exist
  if (!existsSync(evalFolderPath)) {
    mkdirSync(evalFolderPath, { recursive: true })
    console.log(`Created results folder: ${benchmarkType}/${genTimestamp}/${evalFolderName}`)
  }

  // Add timestamp to the results data
  const finalResults: SavedEvaluationResults = {
    evalTimestamp,
    benchmarkFile: baseFileName,
    benchmarkType,
    genTimestamp,
    ...validatedResults,
  }

  // Save to summary.json
  const summaryPath = join(evalFolderPath, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(finalResults, null, 2))
  console.log(`Evaluation results saved to: ${summaryPath}`)

  return finalResults
}

// Find all benchmark files in a folder
export function findAllBenchmarkFiles(folderName: string): string[] {
  const folderPath = join(__dirname, 'data', folderName)

  if (!existsSync(folderPath)) {
    throw new Error(`Benchmark folder not found: ${folderName} at ${folderPath}`)
  }

  try {
    const files = readdirSync(folderPath)
    const benchmarkFiles = files
      .filter((file) => file.endsWith('.json') && file.includes('_gen'))
      .map((file) => join(folderPath, file))
      .sort() // Sort files alphabetically for consistent processing order

    if (benchmarkFiles.length === 0) {
      throw new Error(`No benchmark files found in folder: ${folderName}`)
    }

    return benchmarkFiles
  } catch (error) {
    throw new Error(`Error reading benchmark folder ${folderName}: ${String(error)}`)
  }
}

// Check if a string looks like a specific benchmark file (contains gen + timestamp OR ends with .json)
export function isSpecificBenchmarkFile(target: string): boolean {
  // Pattern: gen followed by 17 digits (timestamp format: YYYYMMDDhhmmssms) OR ends with .json
  return /gen\d{17}/.test(target) || target.endsWith('.json')
}

// Create aggregated summary from multiple evaluation results
export function createAggregatedSummary(
  benchmarkFileName: string,
  allResults: SavedEvaluationResults[],
  nReps: number,
): void {
  if (allResults.length === 0) {
    console.log('No results to aggregate')
    return
  }

  // Validate all results with Zod (defensive validation at boundary)
  const validatedResults = allResults.map((result) => SavedEvaluationResults.parse(result))

  const timestamp = formatTimestamp()

  // Remove .json extension from benchmark filename if present
  const baseFileName = benchmarkFileName.replace(/\.json$/, '')

  // Extract benchmark type and gen timestamp from filename
  const genMatch = baseFileName.match(/^(.+)_(gen\d{17})$/)

  if (!genMatch) {
    console.error(`Invalid benchmark filename format: ${baseFileName}. Cannot create aggregated summary.`)
    return
  }

  const [, benchmarkType, genTimestamp] = genMatch

  // Create aggregated summary
  const aggregatedData = {
    summaryTimestamp: timestamp,
    benchmarkFile: baseFileName,
    benchmarkType,
    genTimestamp,
    totalRuns: validatedResults.length,
    expectedRuns: nReps,
    aggregatedResults: {
      successRate: validatedResults.filter((r) => r.suggestedEvent !== null).length / validatedResults.length,
      confirmationRate: validatedResults.filter((r) => r.allSimUsersConfirmed === true).length / validatedResults.length,
      averageConfirmedSimUsers: validatedResults.reduce((sum, r) => sum + r.confirmedSimUsers.length, 0) / validatedResults.length,
      feasibilityRate: validatedResults.filter((r) => r.evaluationSummary.allCanAttend === true).length / validatedResults.length,
    },
    individualResults: validatedResults.map((result, index) => ({
      runNumber: index + 1,
      evalTimestamp: result.evalTimestamp,
      success: result.suggestedEvent !== null,
      confirmed: result.allSimUsersConfirmed,
      confirmedCount: result.confirmedSimUsers.length,
      feasible: result.evaluationSummary.allCanAttend,
    })),
  }

  // Save aggregated summary to gen timestamp folder
  const benchmarkTypePath = join(__dirname, 'results', benchmarkType)
  const genTimestampPath = join(benchmarkTypePath, genTimestamp)
  const summaryFileName = `runs${timestamp}_summary.json`
  const summaryPath = join(genTimestampPath, summaryFileName)

  // Create folder if it doesn't exist
  if (!existsSync(genTimestampPath)) {
    mkdirSync(genTimestampPath, { recursive: true })
  }

  writeFileSync(summaryPath, JSON.stringify(aggregatedData, null, 2))
  console.log(`\n📊 Aggregated summary saved to: ${summaryPath}`)

  // Print summary statistics
  console.log('\n📈 Summary Statistics:')
  console.log(`  Success Rate: ${(aggregatedData.aggregatedResults.successRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.suggestedEvent !== null).length}/${validatedResults.length})`)
  console.log(`  Confirmation Rate: ${(aggregatedData.aggregatedResults.confirmationRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.allSimUsersConfirmed === true).length}/${validatedResults.length})`)
  console.log(`  Feasibility Rate: ${(aggregatedData.aggregatedResults.feasibilityRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.evaluationSummary.allCanAttend === true).length}/${validatedResults.length})`)
  console.log(`  Average Confirmed SimUsers: ${aggregatedData.aggregatedResults.averageConfirmedSimUsers.toFixed(1)}`)
}

// Helper function to format calendar events with date and time information
export function formatCalendarEvents(calendar: SimpleCalendarEvent[]): string {
  const calendarText = calendar.map((event) => {
    const startDate = event.start.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    })
    const startTime = event.start.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    })
    const endTime = event.end.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    })

    // Check if the event spans multiple days in Eastern Time
    const startDateET = event.start.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
    const endDateET = event.end.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
    const sameDay = startDateET === endDateET

    if (sameDay) {
      return `${startDate} ${startTime}-${endTime}: ${event.summary}`
    } else {
      const endDate = event.end.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      })
      return `${startDate} ${startTime} - ${endDate} ${endTime}: ${event.summary}`
    }
  }).join(', ')

  return calendarText || 'Free all day'
}