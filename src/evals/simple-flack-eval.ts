#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'fs'
import { findBenchmarkFile, saveEvaluationResults, findAllBenchmarkFiles, isSpecificBenchmarkFile, createAggregatedSummary } from './utils'
import { findCommonFreeTime } from '../tools/time_intersection'

// Parse command line arguments for benchmark file or folder
function parseArguments(): { benchmarkFile: string; nReps: number } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      benchmarkFile: {
        type: 'string',
        short: 'f',
        default: 'benchmark_2simusers_1start_2end_60min',
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
    console.log('Usage: tsx src/evals/simple-flack-eval.ts [options]')
    console.log('\nOptions:')
    console.log('  -f, --benchmarkFile     Benchmark file or folder name (default: benchmark_2simusers_1start_2end_60min)')
    console.log('  -r, --nReps             Number of repetitions per case (default: 1)')
    console.log('  -h, --help              Show this help message')
    process.exit(0)
  }

  return {
    benchmarkFile: values.benchmarkFile,
    nReps: parseInt(values.nReps, 10),
  }
}
import { BaseScheduleUser, type EvaluationResults, type SavedEvaluationResults, type BaseScheduleUserData, BenchmarkFileDataSchema } from './user-sims'
import { isConfirming, extractSuggestedTime } from '../agents/evals'
import type { SimpleCalendarEvent } from './user-sims'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'

// Load benchmark data and create BaseScheduleUser sims using import functionality
function loadSimsFromBenchmarkData(benchmarkSims: BaseScheduleUserData[]): BaseScheduleUser[] {
  return benchmarkSims.map((personData) => {
    return BaseScheduleUser.import(personData)
  })
}

// Create all server-side users based on sims
async function createUsersFromSims(sims: BaseScheduleUser[]): Promise<Map<string, BaseScheduleUser>> {
  const usersToCreate = sims.map((sim) => ({
    id: sim.name,
    realName: sim.name,
    isBot: false,
  }))

  const userSimMap = new Map<string, BaseScheduleUser>()
  sims.forEach((sim) => userSimMap.set(sim.name, sim))

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

  return userSimMap
}

// Process bot message responses and add them to appropriate sim buffers
async function processBotMessages(messageResult: Record<string, unknown>, sims: BaseScheduleUser[]): Promise<SimpleCalendarEvent | null> {
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
        console.log(`ℹ️  No meeting time detected in bot message`)
      }
    }

    try {
      // Get channel information to determine which sims should receive this message
      const channelRes = await local_api.channels[':channelId'].$get({
        param: { channelId: resMessage.channelId as string },
      })

      if (!channelRes.ok) {
        console.error(`Failed to get channel info: ${resMessage.channelId as string}`)
        // Fallback: send to all sims if we can't get channel info
        for (const sim of sims) {
          sim.receive(resMessage.text as string)
        }
        continue
      }

      const { userIds } = await channelRes.json()

      // Only send message to sims whose names match the channel userIds
      for (const sim of sims) {
        if (userIds.includes(sim.name)) {
          sim.receive(resMessage.text as string)
        }
      }
    } catch (error) {
      console.error(`Error processing bot message for channel ${resMessage.channelId as string}:`, error)
      // Fallback: send to all sims if there's an error
      for (const sim of sims) {
        sim.receive(resMessage.text as string)
      }
    }
  }

  return suggestedEvent
}

// Clear database before starting evaluation
async function clearDatabase(): Promise<void> {
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

// Simulate a strict turn-based scheduling conversation
async function simulateTurnBasedConversation(sims: BaseScheduleUser[]): Promise<{ topicData: TopicData; suggestedEvent: SimpleCalendarEvent | null; confirmations: Record<string, boolean> }> {
  console.log('\n' + '='.repeat(60))
  console.log('Starting Turn-Based Scheduling Conversation')
  console.log('='.repeat(60))

  if (sims.length === 0) {
    throw new Error('No sims provided for conversation')
  }

  // Log all sims
  sims.forEach((sim, index) => {
    console.log(`Sim ${index + 1}: ${sim.name} - Goal: "${sim.goal}"`)
  })

  // Start conversation: First sim sends initial message through API
  console.log('\n--- Starting Conversation ---')
  const firstSim = sims[0]
  const initialMessage = await firstSim.sendInitialMessage()

  if (!initialMessage) {
    console.log(`${firstSim.name} has no initial message to send`)
    throw new Error('First sim must have an initial message to start conversation')
  }

  console.log(`${firstSim.name}: ${initialMessage}`)

  // Send initial message through local API
  const initMessageRes = await local_api.message.$post({
    json: { userId: firstSim.name, text: initialMessage },
  })
  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId

  console.log(`Created topic: ${topicId}`)

  // Initialize confirmation tracking for all sims
  const confirmations: Record<string, boolean> = {}
  const resetConfirmations = () => {
    sims.forEach((sim) => {
      confirmations[sim.name] = false
    })
  }
  resetConfirmations()

  // Process initial bot responses
  let suggestedEvent = await processBotMessages(initResData, sims)
  if (suggestedEvent) {
    console.log(`  → Initial bot suggestion: ${suggestedEvent.start.toISOString()} - ${suggestedEvent.end.toISOString()} (${suggestedEvent.summary})`)
  }

  // Run turn-based conversation for up to 10 rounds
  const maxRounds = 10
  let roundCount = 0

  while (roundCount < maxRounds) {
    roundCount++
    console.log(`\n--- Round ${roundCount} ---`)

    let anySimSpoke = false

    // Each sim replies to messages in their buffer
    for (const sim of sims) {
      console.log(`${sim.name} buffer length: ${sim.messageBuffer.length}`)
      if (sim.messageBuffer.length > 0) {
      //if (true) {
        const reply = await sim.replyBuffer()

        if (reply) {
          console.log(`${sim.name}: ${reply}`)
          anySimSpoke = true

          // Check if this reply is confirming a meeting suggestion
          if (!confirmations[sim.name]) {
            const isConfirmation = await isConfirming(reply)
            if (isConfirmation) {
              confirmations[sim.name] = true
              console.log(`  → Detected confirmation from ${sim.name}`)
            }
          }

          // Send reply through local API
          const replyRes = await local_api.message.$post({
            json: { userId: sim.name, text: reply , topicId: topicId },
          })

          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to sim buffers
            const newSuggestedEvent = await processBotMessages(replyData, sims)
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
            console.error(`Failed to send reply from ${sim.name}: ${replyRes.statusText}`)
          }
        }
      }
    }

    // Check if all sims have confirmed the current suggested meeting
    if (suggestedEvent) {
      const allConfirmed = sims.every((sim) => confirmations[sim.name])
      if (allConfirmed) {
        console.log('\n🎉 All sims have confirmed the current suggested meeting!')
        console.log('Ending conversation successfully.')
        break
      }
    }

    // If no sim spoke this round, end the conversation
    if (!anySimSpoke) {
      console.log('No sims responded. Ending conversation.')
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
    query: { visibleToUserId: firstSim.name },
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
    const { benchmarkFile, nReps } = parseArguments()

    // Step 2: Determine if it's a single file or folder
    const isFile = isSpecificBenchmarkFile(benchmarkFile)

    if (isFile) {
      console.log(`Using benchmark file: ${benchmarkFile}`)
      console.log(`Running ${nReps} repetition(s) per case`)
      await runRepeatedEvaluation(benchmarkFile, false, nReps)
    } else {
      console.log(`Using benchmark folder: ${benchmarkFile}`)
      const benchmarkFiles = findAllBenchmarkFiles(benchmarkFile)
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
    const benchmarkData = BenchmarkFileDataSchema.parse(parsedData)
    const benchmarkSims = benchmarkData.agents

    console.log('Loading sims from benchmark data...')
    const sims = loadSimsFromBenchmarkData(benchmarkSims)
    console.log(`Loaded ${sims.length} sims:`)
    sims.forEach((sim) => {
      console.log(`  - ${sim.name}: ${sim.calendar.length} calendar events, goal: "${sim.goal}"`)
    })

    // Step 3: Create users in database
    console.log('\nCreating users in database...')
    await createUsersFromSims(sims)

    // Step 4: Run turn-based simulation
    const result = await simulateTurnBasedConversation(sims)
    console.log(`\nConversation completed with ${result.topicData.messages.length} messages`)

    if (result.suggestedEvent) {
      console.log(`Bot suggested meeting: ${result.suggestedEvent.start.toISOString()} - ${result.suggestedEvent.end.toISOString()}`)
      console.log(`Meeting summary: ${result.suggestedEvent.summary}`)
    } else {
      console.log('No meeting was suggested by the bot')
    }

    // Check confirmations
    const confirmedSims = Object.entries(result.confirmations).filter(([_, confirmed]) => confirmed)
    const allSimsConfirmed = confirmedSims.length === sims.length

    console.log('\nConfirmation Status:')
    Object.entries(result.confirmations).forEach(([agentName, confirmed]) => {
      console.log(`  ${confirmed ? '✅' : '❌'} ${agentName}: ${confirmed ? 'Confirmed' : 'Not confirmed'}`)
    })

    if (allSimsConfirmed && confirmedSims.length > 0) {
      console.log('🎉 All sims have confirmed the meeting suggestion!')
    } else if (confirmedSims.length > 0) {
      console.log(`⚠️  Only ${confirmedSims.length}/${sims.length} sims have confirmed`)
    } else {
      console.log('❌ No confirmations detected from any sims')
    }

    // Check feasibility using evalPossibility
    let maxSharedFreeTime = 0
    if (result.suggestedEvent) {
      console.log('\nFeasibility Check:')

      // Check if meeting falls within benchmark time constraints
      const benchmark = benchmarkData.benchmark
      const benchmarkStartTime = new Date(benchmark.startTime)
      const benchmarkEndTime = new Date(benchmark.endTime)
      const meetingStart = result.suggestedEvent.start
      const meetingEnd = result.suggestedEvent.end

      const withinTimeRange = meetingStart >= benchmarkStartTime && meetingEnd <= benchmarkEndTime
      console.log(`  ${withinTimeRange ? '✅' : '❌'} Time constraints: ${withinTimeRange ? 'Within benchmark range' : 'Outside benchmark range'}`)

      if (!withinTimeRange) {
        console.log(`    Benchmark range: ${benchmarkStartTime.toISOString()} to ${benchmarkEndTime.toISOString()}`)
        console.log(`    Suggested meeting: ${meetingStart.toISOString()} to ${meetingEnd.toISOString()}`)
      }

      // Check individual sim availability
      sims.forEach((sim) => {
        const canAttend = sim.evalPossibility(result.suggestedEvent!)
        console.log(`  ${canAttend ? '✅' : '❌'} ${sim.name}: ${canAttend ? 'Available' : 'Calendar conflict'}`)
      })

      // Check if there was actually any common free time when all sims were available
      const commonFreeSlots = findCommonFreeTime(sims, benchmarkStartTime, benchmarkEndTime)
      maxSharedFreeTime = commonFreeSlots.length > 0
        ? Math.max(...commonFreeSlots.map((slot) => slot.end.getTime() - slot.start.getTime())) / (1000 * 60) // duration in minutes
        : 0

      const hasCommonFreeTime = maxSharedFreeTime > 0
      console.log(`  ${hasCommonFreeTime ? '✅' : '❌'} Common availability: ${hasCommonFreeTime ? `Max shared free time: ${maxSharedFreeTime} minutes` : 'No common free time available'}`)
    }

    // Save evaluation results
    console.log('\nSaving evaluation results...')
    const canAttendResults: Record<string, boolean> = {}
    if (result.suggestedEvent) {
      sims.forEach((sim) => {
        canAttendResults[sim.name] = sim.evalPossibility(result.suggestedEvent!)
      })
    }

    const resultsData: EvaluationResults = {
      suggestedEvent: result.suggestedEvent ? {
        start: result.suggestedEvent.start.toISOString(),
        end: result.suggestedEvent.end.toISOString(),
        summary: result.suggestedEvent.summary,
      } : null,
      confirmedSims: confirmedSims.map(([name]) => name),
      allSimsConfirmed,
      canAttend: canAttendResults,
      maxSharedFreeTime,
      evaluationSummary: {
        totalSims: sims.length,
        confirmedCount: confirmedSims.length,
        hasSuggestedEvent: result.suggestedEvent !== null,
        allCanAttend: result.suggestedEvent ? sims.every((sim) => sim.evalPossibility(result.suggestedEvent!)) : false,
      },
    }

    // Extract filename from path for results saving
    const fileName = isFullPath ? benchmarkFileOrPath.split('/').pop() || benchmarkFileOrPath : benchmarkFileOrPath
    const savedResults = saveEvaluationResults(fileName, resultsData)

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
