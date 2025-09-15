import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync, mkdirSync } from 'fs'

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
  resultsData: Record<string, unknown>
): void {
  const timestamp = formatTimestamp()
  
  // Remove .json extension from benchmark filename if present
  const baseFileName = benchmarkFileName.replace(/\.json$/, '')
  
  // Create nested folder structure: results/benchmark_file/eval_timestamp/
  const benchmarkFolderPath = join(__dirname, 'results', baseFileName)
  const evalFolderName = `eval${timestamp}`
  const evalFolderPath = join(benchmarkFolderPath, evalFolderName)
  
  // Create folder if it doesn't exist
  if (!existsSync(evalFolderPath)) {
    mkdirSync(evalFolderPath, { recursive: true })
    console.log(`Created results folder: ${baseFileName}/${evalFolderName}`)
  }
  
  // Add timestamp to the results data
  const finalResults = {
    timestamp,
    benchmarkFile: baseFileName,
    ...resultsData
  }
  
  // Save to summary.json
  const summaryPath = join(evalFolderPath, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(finalResults, null, 2))
  console.log(`Evaluation results saved to: ${summaryPath}`)
}