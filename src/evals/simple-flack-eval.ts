#!/usr/bin/env node
import { readFileSync } from 'fs'
import { findBenchmarkFile, saveEvaluationResults, findAllBenchmarkFiles, isSpecificBenchmarkFile, createAggregatedSummary } from './utils'
import { findCommonFreeTime } from '../tools/time_intersection'

// Parse command line arguments for benchmark file or folder
function parseArgs(): { benchmarkFile: string; nReps: number } {
  const args = process.argv.slice(2)
  
  // Default values
  let benchmarkFile = 'benchmark_2agents_1start_2end_60min'
  let nReps = 1
  
  // Parse named arguments (--arg=value format)
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=')
      if (key === 'file' || key === 'benchmark' || key === 'folder' || key === 'cases') {
        benchmarkFile = value
      } else if (key === 'nReps' || key === 'reps' || key === 'repeat') {
        nReps = parseInt(value, 10)
      }
    }
  }
  
  // Parse positional arguments (backwards compatibility)
  if (args.length >= 1 && !args[0].startsWith('--')) {
    benchmarkFile = args[0]
  }
  if (args.length >= 2 && !args[1].startsWith('--')) {
    nReps = parseInt(args[1], 10)
  }
  
  return { benchmarkFile, nReps }
}
import { BaseScheduleUser } from './agents/user-agents'
import { confirmationCheckAgent, timeExtractionAgent } from './agents/util-agents'
import type { SimpleCalendarEvent } from './agents/user-agents'
import { local_api } from '../shared/api-client'
import type { TopicData } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'

// Load benchmark data and create BaseScheduleUser agents using import functionality
function loadAgentsFromBenchmarkData(benchmarkAgents: Record<string, unknown>[]): BaseScheduleUser[] {
  return benchmarkAgents.map((personData) => {
    return BaseScheduleUser.import(personData)
  })
}

// Create all server-side users based on agents
async function createUsersFromAgents(agents: BaseScheduleUser[]): Promise<Map<string, BaseScheduleUser>> {
  const usersToCreate = agents.map((agent) => ({
    id: agent.name,
    realName: agent.name,
    isBot: false,
  }))

  const userAgentMap = new Map<string, BaseScheduleUser>()
  agents.forEach((agent) => userAgentMap.set(agent.name, agent))

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

  return userAgentMap
}

// Process bot message responses and add them to appropriate agent buffers
async function processBotMessages(messageResult: Record<string, unknown>, agents: BaseScheduleUser[]): Promise<SimpleCalendarEvent | null> {
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
      const extractedEvent = await timeExtractionAgent.extractSuggestedTime(resMessage.text as string)
      if (extractedEvent) {
        suggestedEvent = extractedEvent
        console.log(`Extracted suggested meeting: ${extractedEvent.start.toISOString()} - ${extractedEvent.end.toISOString()} (${extractedEvent.summary})`)
      }
    }

    try {
      // Get channel information to determine which agents should receive this message
      const channelRes = await local_api.channels[':channelId'].$get({
        param: { channelId: resMessage.channelId as string },
      })

      if (!channelRes.ok) {
        console.error(`Failed to get channel info: ${resMessage.channelId as string}`)
        // Fallback: send to all agents if we can't get channel info
        for (const agent of agents) {
          agent.receive(resMessage.text as string)
        }
        continue
      }

      const { userIds } = await channelRes.json()

      // Only send message to agents whose names match the channel userIds
      for (const agent of agents) {
        if (userIds.includes(agent.name)) {
          agent.receive(resMessage.text as string)
        }
      }
    } catch (error) {
      console.error(`Error processing bot message for channel ${resMessage.channelId as string}:`, error)
      // Fallback: send to all agents if there's an error
      for (const agent of agents) {
        agent.receive(resMessage.text as string)
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
async function simulateTurnBasedConversation(agents: BaseScheduleUser[]): Promise<{ topicData: TopicData; suggestedEvent: SimpleCalendarEvent | null; confirmations: Record<string, boolean> }> {
  console.log('\n' + '='.repeat(60))
  console.log('Starting Turn-Based Scheduling Conversation')
  console.log('='.repeat(60))

  if (agents.length === 0) {
    throw new Error('No agents provided for conversation')
  }

  // Log all agents
  agents.forEach((agent, index) => {
    console.log(`Agent ${index + 1}: ${agent.name} - Goal: "${agent.goal}"`)
  })

  // Start conversation: First agent sends initial message through API
  console.log('\n--- Starting Conversation ---')
  const firstAgent = agents[0]
  const initialMessage = await firstAgent.send_initial_message()

  if (!initialMessage) {
    console.log(`${firstAgent.name} has no initial message to send`)
    throw new Error('First agent must have an initial message to start conversation')
  }

  console.log(`${firstAgent.name}: ${initialMessage}`)

  // Send initial message through local API
  const initMessageRes = await local_api.message.$post({
    json: { userId: firstAgent.name, text: initialMessage },
  })
  if (!initMessageRes.ok) {
    throw new Error(`Failed to process initial message: ${initMessageRes.statusText}`)
  }

  const initResData = await initMessageRes.json()
  const topicId = initResData.topicId

  console.log(`Created topic: ${topicId}`)

  // Initialize confirmation tracking for all agents
  const confirmations: Record<string, boolean> = {}
  const resetConfirmations = () => {
    agents.forEach((agent) => {
      confirmations[agent.name] = false
    })
  }
  resetConfirmations()

  // Process initial bot responses
  let suggestedEvent = await processBotMessages(initResData, agents)
  if (suggestedEvent) {
    console.log(`  → Initial bot suggestion: ${suggestedEvent.start.toISOString()} - ${suggestedEvent.end.toISOString()} (${suggestedEvent.summary})`)
  }

  // Run turn-based conversation for up to 10 rounds
  const maxRounds = 10
  let roundCount = 0

  while (roundCount < maxRounds) {
    roundCount++
    console.log(`\n--- Round ${roundCount} ---`)

    let anyAgentSpoke = false

    // Each agent replies to messages in their buffer
    for (const agent of agents) {
      console.log(`${agent.name} buffer length: ${agent.message_buffer.length}`)
      if (agent.message_buffer.length > 0) {
      //if (true) {
        const reply = await agent.reply_buffer()

        if (reply) {
          console.log(`${agent.name}: ${reply}`)
          anyAgentSpoke = true

          // Check if this reply is confirming a meeting suggestion
          if (!confirmations[agent.name]) {
            const isConfirmation = await confirmationCheckAgent.isConfirming(reply)
            if (isConfirmation) {
              confirmations[agent.name] = true
              console.log(`  → Detected confirmation from ${agent.name}`)
            }
          }

          // Send reply through local API
          const replyRes = await local_api.message.$post({
            json: { userId: agent.name, text: reply , topicId: topicId },
          })

          if (replyRes.ok) {
            const replyData = await replyRes.json()
            // Process bot responses and add to agent buffers
            const newSuggestedEvent = await processBotMessages(replyData, agents)
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
            console.error(`Failed to send reply from ${agent.name}: ${replyRes.statusText}`)
          }
        }
      }
    }

    // Check if all agents have confirmed the current suggested meeting
    if (suggestedEvent) {
      const allConfirmed = agents.every((agent) => confirmations[agent.name])
      if (allConfirmed) {
        console.log('\n🎉 All agents have confirmed the current suggested meeting!')
        console.log('Ending conversation successfully.')
        break
      }
    }

    // If no agent spoke this round, end the conversation
    if (!anyAgentSpoke) {
      console.log('No agents responded. Ending conversation.')
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
    query: { visibleToUserId: firstAgent.name },
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
    const { benchmarkFile, nReps } = parseArgs()
    
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
  const allResults: Record<string, unknown>[] = []
  
  for (let rep = 1; rep <= nReps; rep++) {
    if (nReps > 1) {
      console.log(`\n--- Repetition ${rep}/${nReps} ---`)
    }
    try {
      const result = await runSingleEvaluation(benchmarkFileOrPath, isFullPath)
      allResults.push(result)
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
async function runSingleEvaluation(benchmarkFileOrPath: string, isFullPath = false): Promise<Record<string, unknown>> {
  try {
    // Step 1: Clear database
    await clearDatabase()
    
    // Step 2: Load benchmark file and agents from benchmark data
    console.log('\nLoading benchmark file...')
    const dataPath = isFullPath ? benchmarkFileOrPath : findBenchmarkFile(benchmarkFileOrPath)
    console.log(`Found benchmark file at: ${dataPath}`)
    const rawData = readFileSync(dataPath, 'utf-8')
    const benchmarkData = JSON.parse(rawData) as Record<string, unknown>
    const benchmarkAgents = benchmarkData.agents as Record<string, unknown>[]
    
    console.log('Loading agents from benchmark data...')
    const agents = loadAgentsFromBenchmarkData(benchmarkAgents)
    console.log(`Loaded ${agents.length} agents:`)
    agents.forEach((agent) => {
      console.log(`  - ${agent.name}: ${agent.calendar.length} calendar events, goal: "${agent.goal}"`)
    })

    // Step 3: Create users in database
    console.log('\nCreating users in database...')
    await createUsersFromAgents(agents)

    // Step 4: Run turn-based simulation
    const result = await simulateTurnBasedConversation(agents)
    console.log(`\nConversation completed with ${result.topicData.messages.length} messages`)

    if (result.suggestedEvent) {
      console.log(`Bot suggested meeting: ${result.suggestedEvent.start.toISOString()} - ${result.suggestedEvent.end.toISOString()}`)
      console.log(`Meeting summary: ${result.suggestedEvent.summary}`)
    } else {
      console.log('No meeting was suggested by the bot')
    }

    // Check confirmations
    const confirmedAgents = Object.entries(result.confirmations).filter(([_, confirmed]) => confirmed)
    const allAgentsConfirmed = confirmedAgents.length === agents.length

    console.log('\nConfirmation Status:')
    Object.entries(result.confirmations).forEach(([agentName, confirmed]) => {
      console.log(`  ${confirmed ? '✅' : '❌'} ${agentName}: ${confirmed ? 'Confirmed' : 'Not confirmed'}`)
    })

    if (allAgentsConfirmed && confirmedAgents.length > 0) {
      console.log('🎉 All agents have confirmed the meeting suggestion!')
    } else if (confirmedAgents.length > 0) {
      console.log(`⚠️  Only ${confirmedAgents.length}/${agents.length} agents have confirmed`)
    } else {
      console.log('❌ No confirmations detected from any agents')
    }

    // Check feasibility using eval_possibility
    let maxSharedFreeTime = 0
    if (result.suggestedEvent) {
      console.log('\nFeasibility Check:')
      
      // Check if meeting falls within benchmark time constraints
      const benchmark = benchmarkData.benchmark as Record<string, unknown>
      const benchmarkStartTime = new Date(benchmark.startTime as string)
      const benchmarkEndTime = new Date(benchmark.endTime as string)
      const meetingStart = result.suggestedEvent.start
      const meetingEnd = result.suggestedEvent.end
      
      const withinTimeRange = meetingStart >= benchmarkStartTime && meetingEnd <= benchmarkEndTime
      console.log(`  ${withinTimeRange ? '✅' : '❌'} Time constraints: ${withinTimeRange ? 'Within benchmark range' : 'Outside benchmark range'}`)
      
      if (!withinTimeRange) {
        console.log(`    Benchmark range: ${benchmarkStartTime.toISOString()} to ${benchmarkEndTime.toISOString()}`)
        console.log(`    Suggested meeting: ${meetingStart.toISOString()} to ${meetingEnd.toISOString()}`)
      }
      
      // Check individual agent availability
      agents.forEach((agent) => {
        const canAttend = agent.eval_possibility(result.suggestedEvent!)
        console.log(`  ${canAttend ? '✅' : '❌'} ${agent.name}: ${canAttend ? 'Available' : 'Calendar conflict'}`)
      })
      
      // Check if there was actually any common free time when all agents were available
      const commonFreeSlots = findCommonFreeTime(agents, benchmarkStartTime, benchmarkEndTime)
      maxSharedFreeTime = commonFreeSlots.length > 0 
        ? Math.max(...commonFreeSlots.map(slot => slot.end.getTime() - slot.start.getTime())) / (1000 * 60) // duration in minutes
        : 0
      
      const hasCommonFreeTime = maxSharedFreeTime > 0
      console.log(`  ${hasCommonFreeTime ? '✅' : '❌'} Common availability: ${hasCommonFreeTime ? `Max shared free time: ${maxSharedFreeTime} minutes` : 'No common free time available'}`)
    }

    // Save evaluation results
    console.log('\nSaving evaluation results...')
    const canAttendResults: Record<string, boolean> = {}
    if (result.suggestedEvent) {
      agents.forEach((agent) => {
        canAttendResults[agent.name] = agent.eval_possibility(result.suggestedEvent!)
      })
    }
    
    const resultsData = {
      suggestedEvent: result.suggestedEvent ? {
        start: result.suggestedEvent.start.toISOString(),
        end: result.suggestedEvent.end.toISOString(),
        summary: result.suggestedEvent.summary
      } : null,
      confirmedAgents: confirmedAgents.map(([name]) => name),
      allAgentsConfirmed,
      canAttend: canAttendResults,
      maxSharedFreeTime,
      evaluationSummary: {
        totalAgents: agents.length,
        confirmedCount: confirmedAgents.length,
        hasSuggestedEvent: result.suggestedEvent !== null,
        allCanAttend: result.suggestedEvent ? agents.every((agent) => agent.eval_possibility(result.suggestedEvent!)) : false
      }
    }
    
    // Extract filename from path for results saving
    const fileName = isFullPath ? benchmarkFileOrPath.split('/').pop() || benchmarkFileOrPath : benchmarkFileOrPath
    saveEvaluationResults(fileName, resultsData)

    console.log('\n✅ Evaluation completed successfully')
    return resultsData
  } catch (error) {
    console.error('\n❌ Evaluation failed:', error)
    throw error // Re-throw to allow calling function to handle it
  }
}

// Run the evaluation if called directly
if (import.meta.main) {
  void runSimpleEvaluation()
}
