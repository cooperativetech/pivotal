import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'

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
  const folderMatch = baseFilename.match(/^(benchmark_\d+agents_\d+start_\d+end_\d+min)/)
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
  resultsData: Record<string, unknown>,
): void {
  const eval_timestamp = formatTimestamp()

  // Remove .json extension from benchmark filename if present
  const baseFileName = benchmarkFileName.replace(/\.json$/, '')

  // Extract benchmark type and gen timestamp from filename
  // Format: benchmark_2agents_1start_2end_60min_gen20250915121553773
  const genMatch = baseFileName.match(/^(.+)_(gen\d{17})$/)

  if (!genMatch) {
    throw new Error(`Invalid benchmark filename format: ${baseFileName}. Expected format: benchmark_type_gen<timestamp>`)
  }

  const [, benchmarkType, genTimestamp] = genMatch

  // Create 3-level nested folder structure: results/benchmark_type/gen_timestamp/eval_timestamp/
  const benchmarkTypePath = join(__dirname, 'results', benchmarkType)
  const genTimestampPath = join(benchmarkTypePath, genTimestamp)
  const evalFolderName = `eval${eval_timestamp}`
  const evalFolderPath = join(genTimestampPath, evalFolderName)

  // Create folder if it doesn't exist
  if (!existsSync(evalFolderPath)) {
    mkdirSync(evalFolderPath, { recursive: true })
    console.log(`Created results folder: ${benchmarkType}/${genTimestamp}/${evalFolderName}`)
  }

  // Add timestamp to the results data
  const finalResults = {
    eval_timestamp,
    benchmarkFile: baseFileName,
    benchmarkType,
    genTimestamp,
    ...resultsData,
  }

  // Save to summary.json
  const summaryPath = join(evalFolderPath, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(finalResults, null, 2))
  console.log(`Evaluation results saved to: ${summaryPath}`)
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
  allResults: Record<string, unknown>[],
  nReps: number,
): void {
  if (allResults.length === 0) {
    console.log('No results to aggregate')
    return
  }

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
    summary_timestamp: timestamp,
    benchmarkFile: baseFileName,
    benchmarkType,
    genTimestamp,
    totalRuns: allResults.length,
    expectedRuns: nReps,
    aggregatedResults: {
      successRate: allResults.filter((r) => r.suggestedEvent !== null).length / allResults.length,
      confirmationRate: allResults.filter((r) => r.allAgentsConfirmed === true).length / allResults.length,
      averageConfirmedAgents: allResults.reduce((sum, r) => sum + (r.confirmedAgents as string[]).length, 0) / allResults.length,
      feasibilityRate: allResults.filter((r) => {
        const evalSummary = r.evaluationSummary as Record<string, unknown>
        return evalSummary.allCanAttend === true
      }).length / allResults.length,
    },
    individualResults: allResults.map((result, index) => ({
      runNumber: index + 1,
      eval_timestamp: result.eval_timestamp,
      success: result.suggestedEvent !== null,
      confirmed: result.allAgentsConfirmed,
      confirmedCount: (result.confirmedAgents as string[]).length,
      feasible: (result.evaluationSummary as Record<string, unknown>).allCanAttend,
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
  console.log(`  Success Rate: ${(aggregatedData.aggregatedResults.successRate * 100).toFixed(1)}% (${allResults.filter((r) => r.suggestedEvent !== null).length}/${allResults.length})`)
  console.log(`  Confirmation Rate: ${(aggregatedData.aggregatedResults.confirmationRate * 100).toFixed(1)}% (${allResults.filter((r) => r.allAgentsConfirmed === true).length}/${allResults.length})`)
  console.log(`  Feasibility Rate: ${(aggregatedData.aggregatedResults.feasibilityRate * 100).toFixed(1)}% (${allResults.filter((r) => {
    const evalSummary = r.evaluationSummary as Record<string, unknown>
    return evalSummary.allCanAttend === true
  }).length}/${allResults.length})`)
  console.log(`  Average Confirmed Agents: ${aggregatedData.aggregatedResults.averageConfirmedAgents.toFixed(1)}`)
}