#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { local_api } from '../shared/api-client'
import { loadTopics } from '../utils'
import { clearDatabase, DumpedTopicDataOnelineEvals } from './utils'
import { checkBehaviorExpected } from '../agents/evals'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Parse command line arguments
function parseArguments(): { filename: string | null; nReps: number } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      filename: {
        type: 'string',
        short: 'f',
      },
      nReps: {
        type: 'string',
        short: 'n',
        default: '1',
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
  })

  if (values.help) {
    console.log('Usage: tsx src/evals/oneline_evals.ts [options]')
    console.log('\nOptions:')
    console.log('  -f, --filename     Topic JSON filename (e.g., benchmark_2simusers_1start_2end_60min_gen20250922201028577_eval20250923135910404_topic.json)')
    console.log('                     If not specified, runs evaluation on all files in oneliners directory')
    console.log('  -n, --nReps        Number of times to repeat each test (default: 1)')
    console.log('  -h, --help         Show this help message')
    process.exit(0)
  }

  const nReps = parseInt(values.nReps, 10)
  if (isNaN(nReps) || nReps < 1) {
    console.error('Error: nReps must be a positive integer')
    process.exit(1)
  }

  return {
    filename: values.filename || null,
    nReps,
  }
}

// Run a single file evaluation with repetitions
async function runRepeatedOnelineEval(filename: string, nReps: number): Promise<{
  behaviorMatchCount: number
  behaviorMismatchCount: number
  skippedCount: number
  errorCount: number
}> {
  let behaviorMatchCount = 0
  let behaviorMismatchCount = 0
  let skippedCount = 0
  let errorCount = 0

  for (let rep = 1; rep <= nReps; rep++) {
    if (nReps > 1) {
      console.log(`\n--- Repetition ${rep}/${nReps} ---`)
    }

    try {
      const behaviorMatches = await runOnelineEval(filename)
      if (behaviorMatches === null) {
        skippedCount++
        console.log(`🔄 Skipped (no expected behavior)${nReps === 1 ? `: ${filename}` : ''}`)
      } else if (behaviorMatches) {
        behaviorMatchCount++
        console.log(`✅ Behavior matched expectations${nReps === 1 ? `: ${filename}` : ''}`)
      } else {
        behaviorMismatchCount++
        console.log(`❌ Behavior did not match expectations${nReps === 1 ? `: ${filename}` : ''}`)
      }
    } catch (error) {
      errorCount++
      console.error(`💥 Script execution failed${nReps === 1 ? `: ${filename}` : ''}`)
      console.error(`Error: ${String(error)}`)
    }
  }

  // Show repetition summary if multiple reps
  if (nReps > 1) {
    console.log(`\n${'='.repeat(60)}`)
    console.log('REPETITION SUMMARY')
    console.log(`${'='.repeat(60)}`)
    console.log(`File: ${filename}`)
    console.log(`Total repetitions: ${nReps}`)
    console.log(`Behavior matches: ${behaviorMatchCount}`)
    console.log(`Behavior mismatches: ${behaviorMismatchCount}`)
    console.log(`Skipped (no expected behavior): ${skippedCount}`)
    console.log(`Script errors: ${errorCount}`)

    const evaluatedReps = nReps - skippedCount
    if (evaluatedReps > 0) {
      console.log(`Success rate (excluding skipped): ${((behaviorMatchCount / evaluatedReps) * 100).toFixed(1)}%`)
    }
  }

  return { behaviorMatchCount, behaviorMismatchCount, skippedCount, errorCount }
}

// Single evaluation function
async function runOnelineEval(filename: string): Promise<boolean | null> {
  try {
    console.log(`Processing file: ${filename}`)

    // Load JSON file from oneliners directory
    const filePath = join(__dirname, 'data', 'oneliners', filename)
    console.log(`Loading file from: ${filePath}`)

    const rawData = readFileSync(filePath, 'utf-8')

    // Parse and validate JSON data with Zod in one step
    const topicDataOnelineEvals = DumpedTopicDataOnelineEvals.parse(JSON.parse(rawData))

    // Extract and store loadUpToId and expectedBehavior fields
    const loadUpToId = topicDataOnelineEvals.loadUpToId
    const expectedBehavior = topicDataOnelineEvals.expectedBehavior

    console.log(`loadUpToId: ${loadUpToId}`)
    console.log(`expectedBehavior: ${expectedBehavior || 'Not provided - skipping behavior check'}`)

    // Create standard topic data without eval-specific fields
    const topicData = {
      topic: topicDataOnelineEvals.topic,
      states: [...topicDataOnelineEvals.states],
      messages: [...topicDataOnelineEvals.messages],
      users: [...topicDataOnelineEvals.users],
      userData: [...topicDataOnelineEvals.userData],
      channels: [...topicDataOnelineEvals.channels],
    }

    // Find the message that belongs to loadUpToId
    const messages = topicData.messages
    const targetMessage = messages.find((message) => message.id === loadUpToId)

    if (targetMessage) {
      console.log('\nFound target message:')
      console.log(`Message ID: ${targetMessage.id}`)
      console.log(`Message Text: ${targetMessage.text}`)
      console.log(`Message User: ${targetMessage.userId}`)
      console.log(`Message Timestamp: ${targetMessage.timestamp}`)

      const targetTimestamp = new Date(targetMessage.timestamp)
      console.log(`Target timestamp: ${targetTimestamp.toISOString()}`)

      // Filter states: remove entries with createdAt after target message timestamp
      const originalStatesCount = topicData.states.length
      topicData.states = topicData.states.filter((state) => {
        const stateTimestamp = new Date(state.createdAt)
        return stateTimestamp < targetTimestamp
      })
      const filteredStatesCount = topicData.states.length

      // Filter messages: remove entries with timestamp at or after target message timestamp (including the target message itself)
      const originalMessagesCount = topicData.messages.length
      topicData.messages = topicData.messages.filter((message) => {
        const messageTimestamp = new Date(message.timestamp)
        return messageTimestamp < targetTimestamp
      })
      const filteredMessagesCount = topicData.messages.length

      console.log('\nFiltering results:')
      console.log(`States: ${originalStatesCount} -> ${filteredStatesCount} (removed ${originalStatesCount - filteredStatesCount})`)
      console.log(`Messages: ${originalMessagesCount} -> ${filteredMessagesCount} (removed ${originalMessagesCount - filteredMessagesCount})`)

      // Clear database before loading
      await clearDatabase()

      // Load the filtered topic data into the database and get new topic ID
      console.log('\nLoading filtered topic data into database...')
      let newTopicId: string | null = null

      try {
        const filteredJsonContent = JSON.stringify(topicData, null, 2)
        const result = await loadTopics(filteredJsonContent)

        if (filteredMessagesCount > 0 && result?.topicIds?.length > 0) {
          newTopicId = result.topicIds[0]
          console.log(`Successfully loaded filtered topic into database. New topic ID: ${newTopicId}`)
        } else {
          console.log('No messages to load or no topic IDs returned.')
        }
      } catch (error) {
        console.error('Failed to load topic into database:', error)
        throw error
      }

      console.log(`Expected behavior: ${expectedBehavior || 'Not provided'}`)

      // Resend the original message (regardless of whether we loaded filtered data)
      console.log('\nResending original message...')
      console.log(`User: ${targetMessage.userId}`)
      console.log(`Message: ${targetMessage.text}`)

      const messageRes = await local_api.message.$post({
        json: {
          userId: targetMessage.userId,
          text: targetMessage.text,
          topicId: newTopicId || undefined,
        },
      })

      if (!messageRes.ok) {
        throw new Error(`Failed to send message: ${messageRes.statusText}`)
      }

      const messageData = await messageRes.json()
      console.log(`Message sent successfully. Topic ID: ${messageData.topicId}`)

      // Check if bot replied
      if (messageData.resMessages && Array.isArray(messageData.resMessages) && messageData.resMessages.length > 0) {
        console.log('\n--- Bot Responses ---')
        for (const resMessage of messageData.resMessages) {
          console.log(`Bot: ${resMessage.text}`)
        }

        // Check if bot behavior matches expected behavior (only if expectedBehavior is provided)
        if (expectedBehavior) {
          console.log('\n--- Behavior Check ---')
          try {
            const behaviorMatches = await checkBehaviorExpected(messageData.resMessages, expectedBehavior)
            console.log(`Expected behavior: "${expectedBehavior}"`)
            console.log(`Behavior matches: ${behaviorMatches ? '✅ YES' : '❌ NO'}`)

            if (behaviorMatches) {
              console.log('🎉 Bot behavior aligns with expectations!')
            } else {
              console.log('⚠️  Bot behavior does not match expectations')
            }

            return behaviorMatches
          } catch (error) {
            console.error('Error checking behavior:', error)
            return false
          }
        } else {
          console.log('\n--- Behavior Check Skipped ---')
          console.log('🔄 No expected behavior provided - returning null')
          return null
        }
      } else {
        console.log('⚠️ Bot did not reply to the resent message')
        if (expectedBehavior) {
          console.log('❌ Cannot check behavior - no bot responses to evaluate')
          return false
        } else {
          console.log('🔄 No expected behavior provided - returning null')
          return null
        }
      }

    } else {
      console.log(`\n⚠️  Warning: Could not find message with ID: ${loadUpToId}`)
      console.log(`Available message IDs: ${messages.map((m) => m.id).join(', ')}`)
      return false
    }

  } catch (error) {
    console.error('\n❌ Oneline evaluation failed:', error)
    throw error
  }
}

// Main function that handles both single file and batch processing
async function runOnelineEvals(): Promise<void> {
  try {
    const { filename, nReps } = parseArguments()

    if (filename) {
      // Run evaluation on specific file
      console.log(`Running evaluation on single file: ${filename}`)
      if (nReps > 1) {
        console.log(`Repeating ${nReps} times...\n`)
      }

      await runRepeatedOnelineEval(filename, nReps)
    } else {
      // Run evaluation on all files in oneliners directory
      const onelinersDirPath = join(__dirname, 'data', 'oneliners')

      if (!existsSync(onelinersDirPath)) {
        console.error(`Oneliners directory not found: ${onelinersDirPath}`)
        process.exit(1)
      }

      const files = readdirSync(onelinersDirPath)
      const jsonFiles = files.filter((file) => file.endsWith('.json'))

      if (jsonFiles.length === 0) {
        console.log('No JSON files found in oneliners directory')
        return
      }

      console.log(`Found ${jsonFiles.length} files in oneliners directory`)
      console.log('Running evaluation on all files...')
      if (nReps > 1) {
        console.log(`Each file will be repeated ${nReps} times`)
      }

      let filesWithOnlySuccesses = 0
      let filesWithFailures = 0
      let filesWithoutExpectedBehavior = 0
      let filesWithErrors = 0

      for (let i = 0; i < jsonFiles.length; i++) {
        const file = jsonFiles[i]
        console.log(`\n${'='.repeat(80)}`)
        console.log(`Processing file ${i + 1}/${jsonFiles.length}: ${file}`)
        console.log(`${'='.repeat(80)}`)

        const fileResults = await runRepeatedOnelineEval(file, nReps)

        // Categorize file outcomes
        if (fileResults.errorCount > 0) {
          filesWithErrors++
        } else if (fileResults.skippedCount === nReps) {
          // All reps were skipped (no expected behavior)
          filesWithoutExpectedBehavior++
        } else if (fileResults.behaviorMismatchCount > 0) {
          // At least one failure
          filesWithFailures++
        } else {
          // All evaluations succeeded
          filesWithOnlySuccesses++
        }
      }

      console.log(`\n${'='.repeat(80)}`)
      console.log('BATCH PROCESSING SUMMARY')
      console.log(`${'='.repeat(80)}`)
      console.log(`Total files: ${jsonFiles.length}`)
      if (nReps > 1) {
        console.log(`Repetitions per file: ${nReps}`)
      }
      console.log(`Files with only successes: ${filesWithOnlySuccesses}`)
      console.log(`Files with failures: ${filesWithFailures}`)
      console.log(`Files without expected behavior: ${filesWithoutExpectedBehavior}`)
      console.log(`Files with errors: ${filesWithErrors}`)

      const evaluableFiles = jsonFiles.length - filesWithoutExpectedBehavior
      if (evaluableFiles > 0) {
        console.log(`Success rate (files): ${((filesWithOnlySuccesses / evaluableFiles) * 100).toFixed(1)}%`)
      }

      if (evaluableFiles === 0) {
        console.log('\n🔄 No files had expected behavior specified - all were skipped.')
      } else if (filesWithOnlySuccesses === evaluableFiles) {
        console.log('\n🎉 All evaluable files passed! Bot behavior matched expectations in every case.')
      } else if (filesWithErrors > 0) {
        console.log(`\n💥 ${filesWithErrors} file(s) had script execution errors.`)
        console.log(`⚠️  ${filesWithFailures} file(s) had behavior failures.`)
        if (filesWithoutExpectedBehavior > 0) {
          console.log(`🔄 ${filesWithoutExpectedBehavior} file(s) were skipped (no expected behavior).`)
        }
        console.log('Check logs above for details.')
      } else {
        console.log(`\n⚠️  ${filesWithFailures} file(s) had behavior failures.`)
        if (filesWithoutExpectedBehavior > 0) {
          console.log(`🔄 ${filesWithoutExpectedBehavior} file(s) were skipped (no expected behavior).`)
        }
        console.log('Check logs above for details.')
      }
    }
  } catch (error) {
    console.error('\n❌ Oneline evaluations failed:', error)
    process.exit(1)
  }
}

// Run the evaluation if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await runOnelineEvals()
}