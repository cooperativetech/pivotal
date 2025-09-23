#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { local_api } from '../shared/api-client'
import { loadTopics } from '../utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Parse command line arguments
function parseArguments(): { filename: string } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      filename: {
        type: 'string',
        short: 'f',
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
    console.log('  -h, --help         Show this help message')
    process.exit(0)
  }

  if (!values.filename) {
    console.error('Error: --filename is required')
    console.log('Use --help for usage information')
    process.exit(1)
  }

  return {
    filename: values.filename,
  }
}

// Main function
async function runOnelineEvals(): Promise<void> {
  try {
    const { filename } = parseArguments()

    console.log(`Processing file: ${filename}`)

    // Load JSON file from oneliners directory
    const filePath = join(__dirname, 'data', 'oneliners', filename)
    console.log(`Loading file from: ${filePath}`)

    const rawData = readFileSync(filePath, 'utf-8')
    const topicData = JSON.parse(rawData)

    // Extract and store loadUpToId and expectedResult fields
    const loadUpToId = topicData.loadUpToId
    const expectedResult = topicData.expectedResult

    console.log(`loadUpToId: ${loadUpToId}`)
    console.log(`expectedResult: ${expectedResult}`)

    // Delete these fields from the loaded dictionary
    delete topicData.loadUpToId
    delete topicData.expectedResult

    // Find the message that belongs to loadUpToId
    const messages = topicData.messages || []
    const targetMessage = messages.find((message: any) => message.id === loadUpToId)

    if (targetMessage) {
      console.log('\nFound target message:')
      console.log(`Message ID: ${targetMessage.id}`)
      console.log(`Message Text: ${targetMessage.text}`)
      console.log(`Message User: ${targetMessage.userId}`)
      console.log(`Message Timestamp: ${targetMessage.timestamp}`)

      const targetTimestamp = new Date(targetMessage.timestamp)
      console.log(`Target timestamp: ${targetTimestamp.toISOString()}`)

      // Filter states: remove entries with createdAt after target message timestamp
      const originalStatesCount = topicData.states?.length || 0
      if (topicData.states) {
        topicData.states = topicData.states.filter((state: any) => {
          const stateTimestamp = new Date(state.createdAt)
          return stateTimestamp < targetTimestamp
        })
      }
      const filteredStatesCount = topicData.states?.length || 0

      // Filter messages: remove entries with timestamp at or after target message timestamp (including the target message itself)
      const originalMessagesCount = topicData.messages?.length || 0
      if (topicData.messages) {
        topicData.messages = topicData.messages.filter((message: any) => {
          const messageTimestamp = new Date(message.timestamp)
          return messageTimestamp < targetTimestamp
        })
      }
      const filteredMessagesCount = topicData.messages?.length || 0

      console.log(`\nFiltering results:`)
      console.log(`States: ${originalStatesCount} -> ${filteredStatesCount} (removed ${originalStatesCount - filteredStatesCount})`)
      console.log(`Messages: ${originalMessagesCount} -> ${filteredMessagesCount} (removed ${originalMessagesCount - filteredMessagesCount})`)

      // Clear database before loading
      console.log('\nClearing database...')
      try {
        const clearResult = await local_api.clear_test_data.$post()
        if (clearResult.ok) {
          const clearData = await clearResult.json()
          console.log(`Database cleared: ${clearData.message}`)
        }
      } catch (error) {
        console.error('Warning: Could not clear database:', error)
      throw error
    }

      // Only load into database if there are messages to work with
      if (filteredMessagesCount > 0) {
        // Load filtered topic data into database
        console.log('\nLoading filtered topic data into database...')
        try {
          const filteredJsonContent = JSON.stringify(topicData, null, 2)
          const result = await loadTopics(filteredJsonContent)
          const newTopicId = result.topicIds[0]
          console.log(`Successfully loaded filtered topic into database. New topic ID: ${newTopicId}`)
          console.log(`Expected result: ${expectedResult}`)
        } catch (error) {
          console.error('Failed to load topic into database:', error)
          throw error
        }
      } else {
        console.log('\n⚠️  No messages remaining after filtering. Skipping database load.')
        console.log(`Expected result: ${expectedResult}`)
      }
      
    } else {
      console.log(`\n⚠️  Warning: Could not find message with ID: ${loadUpToId}`)
      console.log(`Available message IDs: ${messages.map((m: any) => m.id).join(', ')}`)
    }

  } catch (error) {
    console.error('\n❌ Oneline evaluation failed:', error)
    process.exit(1)
  }
}

// Run the evaluation if called directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await runOnelineEvals()
}