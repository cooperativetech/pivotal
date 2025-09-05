import { z } from 'zod'
import { Agent, run, tool } from '../../agents/agent-sdk'
import { CalendarEvent } from '@shared/api-types'

/**
 * Extract calendar events from a tool-based agent result
 * @param toolResult - The result from running an agent with generateCalendarEvents tool
 * @returns Array of CalendarEvent objects, or null if extraction fails
 */
export function extractCalendarEvents(toolResult: any): CalendarEvent[] | null {
  try {
    // Check if we have modelResponses with function call output
    if (toolResult.modelResponses && toolResult.modelResponses[0]?.output?.[0]) {
      const output = toolResult.modelResponses[0].output[0]
      
      // Check if this is a function call with generateCalendarEvents
      if (output.type === 'function_call' && 
          output.name === 'generateCalendarEvents' && 
          output.arguments) {
        const args = JSON.parse(output.arguments)
        if (args.events && Array.isArray(args.events)) {
          console.log("Extracted events from function call output")
          return args.events
        }
      }
    }

    console.log("Falling back to previous solution")
    // Fallback: look for _generatedItems (keeping this as backup)
    const generatedItems = toolResult.state?._generatedItems || []
    
    // Look for direct tool call item
    const toolCallItem = generatedItems.find((item: any) => 
      item.type === 'tool_call_item' && 
      item.rawItem?.name === 'generateCalendarEvents'
    )
    
    if (toolCallItem) {
      const toolArgs = JSON.parse(toolCallItem.rawItem.arguments)
      const events = toolArgs.events
      
      // Validate events against CalendarEvent schema
      const validatedEvents = z.array(CalendarEvent).parse(events)
      return validatedEvents
    }
    
    return null
  } catch (error) {
    console.error('Error extracting calendar events:', error)
    return null
  }
}

// Create a tool-based agent for better format control
const generateCalendarEvents = tool({
  name: 'generateCalendarEvents',
  description: 'Generate realistic calendar events for a person based on their profession and industry',
  parameters: z.object({
    events: z.array(CalendarEvent).describe('Array of calendar events with ISO timestamps and timezone offsets'),
  }),
  strict: true,
  execute: async ({ events }) => {
    return { events }
  },
})

const toolBasedCalendarAgent = new Agent({
  name: 'toolBasedCalendarAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    temperature: 1,
    'toolChoice': 'required',
  },
  tools: [generateCalendarEvents],
  instructions: `You are a calendar event generator. Generate realistic calendar events for a person's work schedule.

Guidelines:
- Generate events mostly on weekdays, during work hours in the user's timezone (work hours depend on role / industry)
- Don't over-schedule - aim for maximum 60-70% calendar density during work hours, and much less calendar density on weekends, or depending on role / industry
- Make sure all timestamps are in ISO 8601 format with the correct timezone offset
- Events should be relevant to the person's profession and industry
- Include a mix of meetings, work blocks, and other professional activities

Use the generateCalendarEvents tool with your generated events. The tool expects an array of calendar events with proper ISO timestamps and timezone offsets.`,
})

async function testFakeCalendarAgent() {
  const startTime = new Date()
  startTime.setDate(startTime.getDate() + 3)
  const endTime = new Date()
  endTime.setDate(startTime.getDate() + 1)

  const userPrompt = `Generate realistic calendar events in timezone America/New_York.

Date range: ${startTime.toISOString()} to ${endTime.toISOString()}

The person is an experienced software engineer working in technology. They should have a professional schedule with a variety of meetings and work blocks relevant to their role and industry.`

  console.log('Testing tool-based fakeCalendarAgent with prompt:')
  console.log(userPrompt)
  
  console.log('\n=== TOOL-BASED AGENT ===\n')

  try {
    console.log('Running tool-based agent...')
    const toolResult = await run(toolBasedCalendarAgent, userPrompt)
    
    // Extract events using our utility function
    const extractedEvents = extractCalendarEvents(toolResult)
    
    if (extractedEvents) {
      console.log('✅ SUCCESS! Extracted events from tool call:')
      console.log(JSON.stringify(extractedEvents, null, 2))
      console.log(`\nGenerated ${extractedEvents.length} calendar events via tool`)
      console.log('✓ All events pass CalendarEvent validation (validated during extraction)')
    } else {
      console.log('❌ Failed to extract calendar events')
    }
    
    if (toolResult.finalOutput) {
      console.log('\n📋 Agent Summary:')
      console.log(toolResult.finalOutput)
    }
  } catch (error) {
    console.error('Error with tool-based agent:', error)
    if (error instanceof Error) {
      console.error('Error details:', error.message)
    }
  }
}

// Run the test
testFakeCalendarAgent().catch(console.error)