#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { findBenchmarkFile, saveEvaluationResults, findAllBenchmarkFiles, createAggregatedSummary, createResultsFolder, formatTimestamp, clearDatabase } from './utils'
import { dumpTopic } from '../utils'
import { findCommonFreeTime } from '../tools/time_intersection'

// Parse command line arguments for benchmark file or folder
function parseArguments(): { benchmarkFile: string | null; benchmarkFolder: string | null; nReps: number } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      benchmarkFile: {
        type: 'string',
        short: 'f',
      },
      benchmarkFolder: {
        type: 'string',
        short: 'd',
      },
      nReps: {
        type: 'string',
        short: 'r',
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
    console.log('Usage: pnpm run eval [options]')
    console.log('\nOptions:')
    console.log('  -f, --benchmarkFile     Specific benchmark file (e.g., benchmark_2simusers_1start_2end_60min_gen20250915121553773.json)')
    console.log('  -d, --benchmarkFolder   Benchmark folder to run all files in (e.g., benchmark_2simusers_1start_2end_60min)')
    console.log('  -r, --nReps             Number of repetitions per case (default: 1)')
    console.log('  -h, --help              Show this help message')
    console.log('\nIf neither file nor folder is specified, defaults to: benchmark_2simusers_1start_2end_60min')
    process.exit(0)
  }

  // Validate arguments
  if (values.benchmarkFile && values.benchmarkFolder) {
    console.error('Error: Cannot specify both --benchmarkFile and --benchmarkFolder')
    process.exit(1)
  }

  return {
    benchmarkFile: values.benchmarkFile || null,
    benchmarkFolder: values.benchmarkFolder || null,
    nReps: parseInt(values.nReps, 10),
  }
}
import { BaseScheduleUser } from './sim-users'
import { type SavedEvaluationResults, type BaseScheduleUserData, BenchmarkFileData } from './utils'
import { isConfirming, extractSuggestedTime } from '../agents/evals'
import type { SimpleCalendarEvent } from './sim-users'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'

// Load benchmark data and create BaseScheduleUser simUsers using import functionality
function loadSimUsersFromBenchmarkData(benchmarkSimUsers: BaseScheduleUserData[]): BaseScheduleUser[] {
  return benchmarkSimUsers.map((personData) => {
    return BaseScheduleUser.import(personData)
  })
}

// Create all server-side users based on simUsers
async function createUsersFromSimUsers(simUsers: BaseScheduleUser[]): Promise<Map<string, BaseScheduleUser>> {
  const usersToCreate = simUsers.map((simUser) => ({
    id: simUser.name,
    realName: simUser.name,
    isBot: false,
  }))

  const userSimUserMap = new Map<string, BaseScheduleUser>()
  simUsers.forEach((simUser) => userSimUserMap.set(simUser.name, simUser))

  const createUsersRes = await local_api.users.create_fake.$post({
    json: { users: usersToCreate },
  })
  if (!createUsersRes.ok) {
    throw new Error(`Failed to create users: ${createUsersRes.statusText}`)
  }

  const { userIds } = await createUsersRes.json()
  console.log(`Created ${userIds.length} test users`)
  if (userIds.length < 1) {
    throw new Error('Eval requires at least 1 test user')
  }

  return userSimUserMap
}

// Process bot message responses and add them to appropriate simUser buffers
async function processBotMessages(messageResult: Record<string, unknown>, simUsers: BaseScheduleUser[]): Promise<SimpleCalendarEvent | null> {
  if (!messageResult.resMessages || !Array.isArray(messageResult.resMessages)) {
    console.log('⚠️ Bot did not reply - no resMessages in response')
    return null
  }

  if (messageResult.resMessages.length === 0) {
    console.log('⚠️ Bot did not reply - resMessages array is empty')
    return null
  }

  let suggestedEvent: SimpleCalendarEvent | null = null

  // Process each bot response message
  for (const resMessage of messageResult.resMessages as Record<string, unknown>[]) {
    console.log(`Bot response: "${resMessage.text as string}"`)

    // Extract suggested event from this message using Agent
    if (!suggestedEvent) {
      const extractedEvent = await extractSuggestedTime(resMessage.text as string)
      if (extractedEvent) {
        suggestedEvent = extractedEvent
        console.log(`✅ Extracted suggested meeting: ${extractedEvent.start.toISOString()} - ${extractedEvent.end.toISOString()} (${extractedEvent.summary})`)
      } else {
        console.log('ℹ️  No meeting time detected in bot message')
      }
    }

    try {
      // Get channel information to determine which simUsers should receive this message
      const channelRes = await local_api.channels[':channelId'].$get({
        param: { channelId: resMessage.channelId as string },
      })

      if (!channelRes.ok) {
        console.error(`Failed to get channel info: ${resMessage.channelId as string}`)
        // Fallback: send to all simUsers if we can't get channel info
        for (const simUser of simUsers) {
          simUser.receive(resMessage.text as string)
        }
        continue
      }

      const { userIds } = await channelRes.json()

      // Only send message to simUsers whose names match the channel userIds
      for (const simUser of simUsers) {
        if (userIds.includes(simUser.name)) {
          simUser.receive(resMessage.text as string)
        }
      }
    } catch (error) {
      console.error(`Error processing bot message for channel ${resMessage.channelId as string}:`, error)
      // Fallback: send to all simUsers if there's an error
      for (const simUser of simUsers) {
        simUser.receive(resMessage.text as string)
      }
    }
  }

  return suggestedEvent
}


// Simulate a strict turn-based scheduling conversation
async function simulateTurnBasedConversation(simUsers: BaseScheduleUser[]): Promise<{ topicData: TopicData; suggestedEvent: SimpleCalendarEvent | null; confirmations: Record<string, boolean> }> {
  console.log('\n' + '='.repeat(60))
  console.log('Starting Turn-Based Scheduling Conversation')
  console.log('='.repeat(60))

  if (simUsers.length === 0) {
    throw new Error('No simUsers provided for conversation')
  }

  // Log all simUsers
  simUsers.forEach((simUser, index) => {
    console.log(`SimUser ${index + 1}: ${simUser.name} - Goal: "${simUser.goal}"`)
  })

  // Start conversation: First simUser sends initial message through API
  console.log('\n--- Starting Conversation ---')
  const firstSimUser = simUsers[0]
  const initialMessage = await firstSimUser.sendInitialMessage()

  if (!initialMessage) {
    console.log(`${firstSimUser.name} has no initial message to send`)
    throw new Error('First simUser must have an initial message to start conversation')
  }

  console.log(`${firstSimUser.name}: ${initialMessage}`)

  // Send initial message through local API
  const initMessageRes = await local_api.message.$post({
    json: { userId: firstSimUser.name, text: initialMessage },
  })
  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId

  console.log(`Created topic: ${topicId}`)

  // Initialize confirmation tracking for all simUsers
  const confirmations: Record<string, boolean> = {}
  const resetConfirmations = () => {
    simUsers.forEach((simUser) => {
      confirmations[simUser.name] = false
    })
  }
  resetConfirmations()

  // Process initial bot responses
  let suggestedEvent = await processBotMessages(initResData, simUsers)
  if (suggestedEvent) {
    console.log(`  → Initial bot suggestion: ${suggestedEvent.start.toISOString()} - ${suggestedEvent.end.toISOString()} (${suggestedEvent.summary})`)
  }

  // Run turn-based conversation for up to 10 rounds
  const maxRounds = 10
  let roundCount = 0

  while (roundCount < maxRounds) {
    roundCount++
    console.log(`\n--- Round ${roundCount} ---`)

    let anySimUserSpoke = false

    // Each simUser replies to messages in their buffer
    for (const simUser of simUsers) {
      console.log(`${simUser.name} buffer length: ${simUser.messageBuffer.length}`)
      if (simUser.messageBuffer.length > 0) {
      //if (true) {
        const reply = await simUser.replyBuffer()

        if (reply) {
          console.log(`${simUser.name}: ${reply}`)
          anySimUserSpoke = true

          // Check if this reply is confirming a meeting suggestion
          if (!confirmations[simUser.name]) {
            const isConfirmation = await isConfirming(reply)
            if (isConfirmation) {
              confirmations[simUser.name] = true
              console.log(`  → Detected confirmation from ${simUser.name}`)
            }
          }

          // Send reply through local API
          const replyRes = await local_api.message.$post({
            json: { userId: simUser.name, text: reply , topicId: topicId },
          })

          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to simUser buffers
            const newSuggestedEvent = await processBotMessages(replyData, simUsers)
            if (newSuggestedEvent) {
              // Check if this is a new/different suggested event
              if (!suggestedEvent || newSuggestedEvent.start.getTime() !== suggestedEvent.start.getTime() || newSuggestedEvent.end.getTime() !== suggestedEvent.end.getTime()) {
                console.log(`  → Bot suggested new meeting: ${newSuggestedEvent.start.toISOString()} - ${newSuggestedEvent.end.toISOString()} (${newSuggestedEvent.summary})`)
                if (suggestedEvent) {
                  console.log(`  → Previous meeting was: ${suggestedEvent.start.toISOString()} - ${suggestedEvent.end.toISOString()} (${suggestedEvent.summary})`)
                  console.log('  → Resetting all confirmations due to meeting change')
                  resetConfirmations()
                }
                suggestedEvent = newSuggestedEvent
              }
            }
          } else {
            console.error(`Failed to send reply from ${simUser.name}: ${replyRes.statusText}`)
          }
        }
      }
    }

    // Check if all simUsers have confirmed the current suggested meeting
    if (suggestedEvent) {
      const allConfirmed = simUsers.every((simUser) => confirmations[simUser.name])
      if (allConfirmed) {
        console.log('\n🎉 All simUsers have confirmed the current suggested meeting!')
        console.log('Ending conversation successfully.')
        break
      }
    }

    // If no simUser spoke this round, end the conversation
    if (!anySimUserSpoke) {
      console.log('No simUsers responded. Ending conversation.')
      break
    }
  }

  if (roundCount >= maxRounds) {
    console.log(`\nReached maximum rounds (${maxRounds}). Ending conversation.`)
  }

  console.log('\n--- Conversation Complete ---')

  // Get final topic data
  const topicResponse = await local_api.topics[':topicId'].$get({
    param: { topicId },
    query: { visibleToUserId: firstSimUser.name },
  })

  if (!topicResponse.ok) {
    throw new Error('Failed to get final topic data')
  }

  const topicData = unserializeTopicData(await topicResponse.json())
  return { topicData, suggestedEvent, confirmations }
}

// Main evaluation function
async function runSimpleEvaluation(): Promise<void> {
  console.log('=� Starting Simple Flack Evaluation')

  try {
    // Step 1: Parse command line arguments
    const { benchmarkFile, benchmarkFolder, nReps } = parseArguments()

    // Step 2: Determine what to run based on arguments
    if (benchmarkFile) {
      // Run specific file
      console.log(`Using benchmark file: ${benchmarkFile}`)
      console.log(`Running ${nReps} repetition(s) per case`)
      await runRepeatedEvaluation(benchmarkFile, false, nReps)
    } else {
      // Run folder (either specified or default)
      const folderName = benchmarkFolder || 'benchmark_2simusers_1start_2end_60min'
      console.log(`Using benchmark folder: ${folderName}`)
      const benchmarkFiles = findAllBenchmarkFiles(folderName)
      console.log(`Found ${benchmarkFiles.length} benchmark files in folder`)
      console.log(`Running ${nReps} repetition(s) per case`)

      for (let i = 0; i < benchmarkFiles.length; i++) {
        console.log(`\n${'='.repeat(80)}`)
        console.log(`Running evaluation ${i + 1}/${benchmarkFiles.length}`)
        console.log(`${'='.repeat(80)}`)
        await runRepeatedEvaluation(benchmarkFiles[i], true, nReps)
      }

      console.log(`\n✅ Completed all ${benchmarkFiles.length} evaluations (${nReps} reps each)`)
    }
  } catch (error) {
    console.error('\n❌ Evaluation failed:', error)
    process.exit(1)
  }
}

// Wrapper function to run repeated evaluations
async function runRepeatedEvaluation(benchmarkFileOrPath: string, isFullPath: boolean, nReps: number): Promise<void> {
  const allResults: SavedEvaluationResults[] = []

  for (let rep = 1; rep <= nReps; rep++) {
    if (nReps > 1) {
      console.log(`\n--- Repetition ${rep}/${nReps} ---`)
    }
    try {
      const result = await runSingleEvaluation(benchmarkFileOrPath, isFullPath)
      if (result) {
        allResults.push(result)
      }
    } catch (error) {
      console.error(`Repetition ${rep} failed:`, error)
      // Continue with other repetitions
    }
  }

  if (nReps > 1) {
    console.log(`\n✅ Completed all ${nReps} repetitions for this case`)

    // Create aggregated summary if we have multiple runs
    if (allResults.length > 1) {
      const fileName = isFullPath ? benchmarkFileOrPath.split('/').pop() || benchmarkFileOrPath : benchmarkFileOrPath
      createAggregatedSummary(fileName, allResults, nReps)
    }
  }
}

// Run a single evaluation for a specific benchmark file
async function runSingleEvaluation(benchmarkFileOrPath: string, isFullPath = false): Promise<SavedEvaluationResults | null> {
  try {
    // Step 1: Clear database
    await clearDatabase()

    // Step 2: Load benchmark file and agents from benchmark data
    console.log('\nLoading benchmark file...')
    const dataPath = isFullPath ? benchmarkFileOrPath : findBenchmarkFile(benchmarkFileOrPath)
    console.log(`Found benchmark file at: ${dataPath}`)
    const rawData = readFileSync(dataPath, 'utf-8')
    const parsedData: unknown = JSON.parse(rawData)

    // Validate benchmark data structure with Zod
    const benchmarkData = BenchmarkFileData.parse(parsedData)
    const benchmarkSimUsers = benchmarkData.simUsers

    console.log('Loading simUsers from benchmark data...')
    const simUsers = loadSimUsersFromBenchmarkData(benchmarkSimUsers)
    console.log(`Loaded ${simUsers.length} simUsers:`)
    simUsers.forEach((simUser) => {
      console.log(`  - ${simUser.name}: ${simUser.calendar.length} calendar events, goal: "${simUser.goal}"`)
    })

    // Step 3: Create users in database
    console.log('\nCreating users in database...')
    await createUsersFromSimUsers(simUsers)

    // Step 4: Run turn-based simulation
    const result = await simulateTurnBasedConversation(simUsers)
    console.log(`\nConversation completed with ${result.topicData.messages.length} messages`)

    if (result.suggestedEvent) {
      console.log(`Bot suggested meeting: ${result.suggestedEvent.start.toISOString()} - ${result.suggestedEvent.end.toISOString()}`)
      console.log(`Meeting summary: ${result.suggestedEvent.summary}`)
    } else {
      console.log('No meeting was suggested by the bot')
    }

    // Check confirmations
    const confirmedSimUsers = Object.entries(result.confirmations).filter(([_, confirmed]) => confirmed)
    const allSimUsersConfirmed = confirmedSimUsers.length === simUsers.length

    console.log('\nConfirmation Status:')
    Object.entries(result.confirmations).forEach(([agentName, confirmed]) => {
      console.log(`  ${confirmed ? '✅' : '❌'} ${agentName}: ${confirmed ? 'Confirmed' : 'Not confirmed'}`)
    })

    if (allSimUsersConfirmed && confirmedSimUsers.length > 0) {
      console.log('🎉 All simUsers have confirmed the meeting suggestion!')
    } else if (confirmedSimUsers.length > 0) {
      console.log(`⚠️  Only ${confirmedSimUsers.length}/${simUsers.length} simUsers have confirmed`)
    } else {
      console.log('❌ No confirmations detected from any simUsers')
    }

    // Check feasibility using evalPossibility
    let maxSharedFreeTime = 0
    let withinTimeRange = false
    if (result.suggestedEvent) {
      console.log('\nFeasibility Check:')

      // Check if meeting falls within benchmark time constraints
      const benchmark = benchmarkData.benchmark
      const benchmarkStartTime = new Date(benchmark.startTime)
      const benchmarkEndTime = new Date(benchmark.endTime)
      const meetingStart = result.suggestedEvent.start
      const meetingEnd = result.suggestedEvent.end

      withinTimeRange = meetingStart >= benchmarkStartTime && meetingEnd <= benchmarkEndTime
      console.log(`  ${withinTimeRange ? '✅' : '❌'} Time constraints: ${withinTimeRange ? 'Within benchmark range' : 'Outside benchmark range'}`)

      if (!withinTimeRange) {
        console.log(`    Benchmark range: ${benchmarkStartTime.toISOString()} to ${benchmarkEndTime.toISOString()}`)
        console.log(`    Suggested meeting: ${meetingStart.toISOString()} to ${meetingEnd.toISOString()}`)
      }

      // Check individual simUser availability
      simUsers.forEach((simUser) => {
        const canAttend = simUser.evalPossibility(result.suggestedEvent!)
        console.log(`  ${canAttend ? '✅' : '❌'} ${simUser.name}: ${canAttend ? 'Available' : 'Calendar conflict'}`)
      })

      // Check if there was actually any common free time when all simUsers were available
      const commonFreeSlots = findCommonFreeTime(simUsers, benchmarkStartTime, benchmarkEndTime)
      maxSharedFreeTime = commonFreeSlots.length > 0
        ? Math.max(...commonFreeSlots.map((slot) => slot.end.getTime() - slot.start.getTime())) / (1000 * 60) // duration in minutes
        : 0

      const hasCommonFreeTime = maxSharedFreeTime > benchmarkData.benchmark.meetingLength
      console.log(`  ${hasCommonFreeTime ? '✅' : '❌'} Common availability: ${hasCommonFreeTime ? `Max shared free time: ${maxSharedFreeTime} minutes (required: ${benchmarkData.benchmark.meetingLength} minutes)` : `Insufficient shared free time: ${maxSharedFreeTime} minutes (required: ${benchmarkData.benchmark.meetingLength} minutes)`}`)
    }

    // Overall evaluation judgment
    console.log('\n--- Overall Evaluation Judgment ---')
    const hasSufficientFreeTime = maxSharedFreeTime > benchmarkData.benchmark.meetingLength
    const meetingWasFound = result.suggestedEvent !== null
    const allUsersCanAttend = result.suggestedEvent ? simUsers.every((simUser) => simUser.evalPossibility(result.suggestedEvent!)) : false

    let evaluationSucceeded = false
    let evaluationReason = ''

    if (hasSufficientFreeTime && meetingWasFound && allUsersCanAttend) {
      evaluationSucceeded = true
      evaluationReason = 'SUCCESS: Meeting found when users had sufficient shared free time and all users can attend'
    } else if (!hasSufficientFreeTime && !meetingWasFound) {
      evaluationSucceeded = true
      evaluationReason = 'SUCCESS: No meeting found when there was insufficient shared free time'
    } else if (hasSufficientFreeTime && (!meetingWasFound || !allUsersCanAttend)) {
      evaluationSucceeded = false
      evaluationReason = `FAILURE: Sufficient shared free time (${maxSharedFreeTime} min > ${benchmarkData.benchmark.meetingLength} min) but ${!meetingWasFound ? 'no meeting suggested' : 'not all users can attend suggested meeting'}`
    } else if (!hasSufficientFreeTime && meetingWasFound) {
      evaluationSucceeded = false
      evaluationReason = `FAILURE: Meeting suggested when insufficient shared free time (${maxSharedFreeTime} min <= ${benchmarkData.benchmark.meetingLength} min)`
    } else {
      evaluationSucceeded = false
      evaluationReason = 'FAILURE: Unexpected evaluation state'
    }

    console.log(`${evaluationSucceeded ? '✅' : '❌'} ${evaluationReason}`)

    // Save evaluation results
    console.log('\nSaving evaluation results...')
    const canAttendResults: Record<string, boolean> = {}
    if (result.suggestedEvent) {
      simUsers.forEach((simUser) => {
        canAttendResults[simUser.name] = simUser.evalPossibility(result.suggestedEvent!)
      })
    }

    // Extract filename from path
    const fileName = isFullPath ? benchmarkFileOrPath.split('/').pop() || benchmarkFileOrPath : benchmarkFileOrPath
    const baseFileName = fileName.replace(/\.json$/, '')

    // Get genTimestamp directly from benchmark data
    const genTimestamp = benchmarkData.benchmark.genTimestamp || 'unknown'

    const resultsData: SavedEvaluationResults = {
      evalTimestamp: formatTimestamp(),
      benchmarkFile: baseFileName,
      genTimestamp,
      suggestedEvent: result.suggestedEvent ? {
        start: result.suggestedEvent.start.toISOString(),
        end: result.suggestedEvent.end.toISOString(),
        summary: result.suggestedEvent.summary,
      } : null,
      confirmedSimUsers: confirmedSimUsers.map(([name]) => name),
      allSimUsersConfirmed,
      canAttend: canAttendResults,
      maxSharedFreeTime,
      evaluationSummary: {
        totalSimUsers: simUsers.length,
        confirmedCount: confirmedSimUsers.length,
        hasSuggestedEvent: result.suggestedEvent !== null,
        allCanAttend: result.suggestedEvent ? simUsers.every((simUser) => simUser.evalPossibility(result.suggestedEvent!)) : false,
        withinTimeRange,
        evaluationSucceeded,
      },
    }

    // Create results folder
    const evalFolderPath = createResultsFolder(fileName)

    // Save evaluation results
    const savedResults = saveEvaluationResults(evalFolderPath, resultsData)

    // Dump topic data to the same results folder
    console.log('\nSaving topic conversation history...')
    const topicId = result.topicData.topic.id
    const topicData = await dumpTopic(topicId)

    // Create topic filename with full benchmark info: benchmarkType_gen<timestamp>_eval<timestamp>_topic.json
    const topicFileName = `${baseFileName}_eval${resultsData.evalTimestamp}_topic.json`
    const topicPath = join(evalFolderPath, topicFileName)
    writeFileSync(topicPath, JSON.stringify(topicData, null, 2))
    console.log(`Topic conversation history saved to: ${topicPath}`)

    console.log('\n✅ Evaluation completed successfully')
    return savedResults
  } catch (error) {
    console.error('\n❌ Evaluation failed:', error)
    return null // Return null instead of throwing to allow for graceful handling
  }
}

// Run the evaluation if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.on('SIGINT', () => process.nextTick(() => process.exit(1)))
  await runSimpleEvaluation()
}
