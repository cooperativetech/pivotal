import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { z } from 'zod'
import type { SimpleCalendarEvent } from './sim-users'
import { local_api } from '../shared/api-client'

// Zod schemas for runtime validation
const SerializedCalendarEvent = z.strictObject({
  start: z.string(),
  end: z.string(),
  summary: z.string(),
})

export const HistoryMessage = z.strictObject({
  sender: z.enum(['bot', 'user']),
  message: z.string(),
})

export const SerializedSimUserData = z.strictObject({
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
  nGroups: z.number(),
  groupIndex: z.number(),
  genTimestamp: z.string(),
})

export const BenchmarkFileData = z.strictObject({
  benchmark: BenchmarkData,
  simUsers: z.array(SerializedSimUserData),
})

const EvaluationSummary = z.strictObject({
  totalSimUsers: z.number(),
  confirmedCount: z.number(),
  hasSuggestedEvents: z.boolean(),
  allCanAttend: z.boolean(),
  withinTimeRange: z.boolean(),
  evaluationSucceeded: z.boolean(),
})

export const EvaluationResults = z.strictObject({
  suggestedEvents: z.array(z.strictObject({
    start: z.string(),
    end: z.string(),
    summary: z.string(),
  }).nullable()),
  confirmedSimUsers: z.array(z.string()),
  allSimUsersConfirmed: z.boolean(),
  maxSharedFreeTimes: z.array(z.number()),
  allCanAttends: z.array(z.boolean()),
  evaluationSummary: EvaluationSummary,
})

export const SavedEvaluationResults = EvaluationResults.extend({
  evalTimestamp: z.string(),
  benchmarkFile: z.string(),
  genTimestamp: z.string(),
})

// Type exports inferred from Zod schemas
export type BaseScheduleUserData = z.infer<typeof SerializedSimUserData>
export type BenchmarkData = z.infer<typeof BenchmarkData>
export type BenchmarkFileData = z.infer<typeof BenchmarkFileData>
export type EvaluationSummary = z.infer<typeof EvaluationSummary>
export type EvaluationResults = z.infer<typeof EvaluationResults>
export type SavedEvaluationResults = z.infer<typeof SavedEvaluationResults>
export type HistoryMessage = z.infer<typeof HistoryMessage>

// Zod schemas for dumped topic data structure used in oneline evals
const DumpedSlackMessage = z.strictObject({
  id: z.string(),
  topicId: z.string(),
  userId: z.string(),
  channelId: z.string(),
  text: z.string(),
  timestamp: z.string(),
  rawTs: z.string(),
  threadTs: z.string().nullable(),
  autoMessageId: z.string().nullable().optional(),
  raw: z.record(z.unknown()),
})

const DumpedPerUserContext = z.record(z.record(z.unknown()))

const DumpedTopicState = z.strictObject({
  id: z.string(),
  topicId: z.string(),
  userIds: z.array(z.string()),
  summary: z.string(),
  isActive: z.boolean(),
  perUserContext: DumpedPerUserContext,
  createdByMessageId: z.string(),
  createdAt: z.string(),
  createdByMessageRawTs: z.string(),
})

const DumpedTopic = z.strictObject({
  id: z.string(),
  botUserId: z.string(),
  workflowType: z.string(),
  createdAt: z.string(),
})

const DumpedUser = z.strictObject({
  id: z.string(),
  teamId: z.string(),
  realName: z.string(),
  email: z.string().nullable(),
  tz: z.string().optional(),
  isBot: z.boolean().optional(),
  deleted: z.boolean().optional(),
  updated: z.string().optional(),
  raw: z.record(z.unknown()).optional(),
})

const DumpedChannel = z.strictObject({
  id: z.string(),
  userIds: z.array(z.string()),
})

// Standard dumped topic data structure (without eval-specific fields)
export const DumpedTopicData = z.strictObject({
  topic: DumpedTopic,
  states: z.array(DumpedTopicState),
  messages: z.array(DumpedSlackMessage),
  users: z.array(DumpedUser),
  userData: z.array(z.unknown()),
  channels: z.array(DumpedChannel),
})

// Oneline evaluation dumped topic data (includes eval-specific fields)
export const DumpedTopicDataOnelineEvals = z.strictObject({
  loadUpToId: z.string(),
  expectedBehavior: z.string().optional(),
  topic: DumpedTopic,
  states: z.array(DumpedTopicState),
  messages: z.array(DumpedSlackMessage),
  users: z.array(DumpedUser),
  userData: z.array(z.unknown()),
  channels: z.array(DumpedChannel),
})

// Type exports for dumped topic data
export type DumpedTopicData = z.infer<typeof DumpedTopicData>
export type DumpedTopicDataOnelineEvals = z.infer<typeof DumpedTopicDataOnelineEvals>
export type DumpedSlackMessage = z.infer<typeof DumpedSlackMessage>
export type DumpedTopicState = z.infer<typeof DumpedTopicState>
export type DumpedTopic = z.infer<typeof DumpedTopic>
export type DumpedUser = z.infer<typeof DumpedUser>
export type DumpedChannel = z.infer<typeof DumpedChannel>

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
  const folderMatch = baseFilename.match(/^(benchmark_\d+simusers_[\d-]+start_[\d-]+end_\d+min)/)
  if (folderMatch) {
    const folderName = folderMatch[1]
    const subDirPath = join(__dirname, 'data', folderName, `${baseFilename}.json`)
    if (existsSync(subDirPath)) {
      return subDirPath
    }
  }

  throw new Error(`Benchmark file not found: ${filename}. Tried:\n  - ${directPath}\n  - ${join(__dirname, 'data', folderMatch?.[1] || 'unknown', `${baseFilename}.json`)}`)
}

// Create results folder and return the path
export function createResultsFolder(benchmarkName: string, evalTimestamp: string): string {
  // benchmarkName is the relative path from data/, e.g. "benchmarks/benchmark_2simusers_1-25start_1-75end_60min_gen20251008152504730"

  // Create folder structure mirroring the benchmark structure: results/benchmarks/benchmark_name_gen<timestamp>/eval<timestamp>/
  const resultsPath = join(__dirname, 'results', benchmarkName)
  const evalFolderName = `eval${evalTimestamp}`
  const evalFolderPath = join(resultsPath, evalFolderName)

  // Create folder if it doesn't exist
  if (!existsSync(evalFolderPath)) {
    mkdirSync(evalFolderPath, { recursive: true })
    console.log(`Created results folder: results/${benchmarkName}/${evalFolderName}`)
  }

  return evalFolderPath
}

// Save evaluation results to JSON file
export function saveEvaluationResults(
  evalFolderPath: string,
  resultsData: SavedEvaluationResults,
): SavedEvaluationResults {
  // Validate results data structure with Zod (defensive validation at boundary)
  const validatedResults = SavedEvaluationResults.parse(resultsData)

  // Save to summary.json
  const summaryPath = join(evalFolderPath, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(validatedResults, null, 2))
  console.log(`Evaluation results saved to: ${summaryPath}`)

  return validatedResults
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

// Find all multigroup benchmark subfolders (returns subfolder paths, not individual files)
export function findAllMultigroupBenchmarkFolders(folderName: string): string[] {
  const folderPath = join(__dirname, 'data', folderName)

  if (!existsSync(folderPath)) {
    throw new Error(`Multigroup benchmark folder not found: ${folderName} at ${folderPath}`)
  }

  try {
    // Look for multigroup_benchmark_gen* subfolders
    const subFolders = readdirSync(folderPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('multigroup_benchmark_gen'))
      .map(dirent => join(folderPath, dirent.name))
      .sort() // Sort subfolders alphabetically for consistent processing order

    if (subFolders.length === 0) {
      throw new Error(`No multigroup benchmark subfolders found in: ${folderName}`)
    }

    return subFolders
  } catch (error) {
    throw new Error(`Error reading multigroup benchmark folder ${folderName}: ${String(error)}`)
  }
}

// Find all benchmark files within a multigroup subfolder
export function findAllFilesInMultigroupFolder(subFolderPath: string): string[] {
  if (!existsSync(subFolderPath)) {
    throw new Error(`Multigroup subfolder not found: ${subFolderPath}`)
  }

  try {
    const files = readdirSync(subFolderPath)
    const benchmarkFiles = files
      .filter((file) => file.endsWith('.json') && file.includes('_group') && file.includes('_gen'))
      .map((file) => join(subFolderPath, file))
      .sort() // Sort files alphabetically for consistent processing order

    if (benchmarkFiles.length === 0) {
      throw new Error(`No multigroup benchmark files found in subfolder: ${subFolderPath}`)
    }

    return benchmarkFiles
  } catch (error) {
    throw new Error(`Error reading multigroup subfolder ${subFolderPath}: ${String(error)}`)
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
  const genMatch = baseFileName.match(/^(.+)_gen(\d{17})$/)

  if (!genMatch) {
    console.error(`Invalid benchmark filename format: ${baseFileName}. Cannot create aggregated summary.`)
    return
  }

  const [, benchmarkType, genTimestamp] = genMatch

  // Create aggregated summary
  const aggregatedData = {
    summaryTimestamp: timestamp,
    benchmarkFile: baseFileName,
    genTimestamp,
    totalRuns: validatedResults.length,
    expectedRuns: nReps,
    aggregatedResults: {
      successRate: validatedResults.filter((r) => r.evaluationSummary.evaluationSucceeded).length / validatedResults.length,
      confirmationRate: validatedResults.filter((r) => r.allSimUsersConfirmed === true).length / validatedResults.length,
      averageConfirmedSimUsers: validatedResults.reduce((sum, r) => sum + r.confirmedSimUsers.length, 0) / validatedResults.length,
      feasibilityRate: validatedResults.filter((r) => r.evaluationSummary.allCanAttend === true).length / validatedResults.length,
      timeConstraintsRate: validatedResults.filter((r) => r.evaluationSummary.withinTimeRange === true).length / validatedResults.length,
    },
    individualResults: validatedResults.map((result, index) => ({
      runNumber: index + 1,
      evalTimestamp: result.evalTimestamp,
      success: result.evaluationSummary.evaluationSucceeded,
      confirmed: result.allSimUsersConfirmed,
      confirmedCount: result.confirmedSimUsers.length,
      feasible: result.evaluationSummary.allCanAttend,
      withinTimeRange: result.evaluationSummary.withinTimeRange,
    })),
  }

  // Save aggregated summary to gen timestamp folder
  const benchmarkTypePath = join(__dirname, 'results', benchmarkType)
  const genTimestampPath = join(benchmarkTypePath, `gen${genTimestamp}`)
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
  console.log(`  Success Rate: ${(aggregatedData.aggregatedResults.successRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.evaluationSummary.evaluationSucceeded).length}/${validatedResults.length})`)
  console.log(`  Confirmation Rate: ${(aggregatedData.aggregatedResults.confirmationRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.allSimUsersConfirmed === true).length}/${validatedResults.length})`)
  console.log(`  Feasibility Rate: ${(aggregatedData.aggregatedResults.feasibilityRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.evaluationSummary.allCanAttend === true).length}/${validatedResults.length})`)
  console.log(`  Time Constraints Rate: ${(aggregatedData.aggregatedResults.timeConstraintsRate * 100).toFixed(1)}% (${validatedResults.filter((r) => r.evaluationSummary.withinTimeRange === true).length}/${validatedResults.length})`)
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

// Clear database before starting evaluation
export async function clearDatabase(): Promise<void> {
  console.log('Clearing database...')
  try {
    const result = await local_api.clear_test_data.$post()
    if (result.ok) {
      const data = await result.json()
      console.log(`Database cleared: ${data.message}`)
    }
  } catch (error) {
    console.error('Warning: Could not clear database:', error)
    throw error
  }
}

// Get benchmark folders from a benchmark set
export async function getBenchmarksFromSet(benchmarkSetFolder: string): Promise<string[]> {
  const folderPath = join(__dirname, 'data', benchmarkSetFolder)

  if (!existsSync(folderPath)) {
    throw new Error(`Benchmark set folder not found: ${benchmarkSetFolder} at ${folderPath}`)
  }

  try {
    // Find all benchmark_*_gen* folders within the top-level folder
    const subFolders = readdirSync(folderPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.includes('_gen'))
      .map(dirent => join(benchmarkSetFolder, dirent.name))
      .sort()

    if (subFolders.length === 0) {
      throw new Error(`No benchmark folders found in set: ${benchmarkSetFolder}`)
    }

    console.log(`Found ${subFolders.length} benchmark(s) in set`)
    return subFolders
  } catch (error) {
    throw new Error(`Error reading benchmark set folder ${benchmarkSetFolder}: ${String(error)}`)
  }
}