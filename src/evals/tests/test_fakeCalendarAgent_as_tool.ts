import { z } from 'zod'
import { Agent, run, tool } from '../../agents/agent-sdk'
import { CalendarEvent } from '@shared/api-types'

// Create a tool-based agent for better format control
let generatedEvents: any[] = []

const generateCalendarEvents = tool({
  name: 'generateCalendarEvents',
  description: 'Generate realistic calendar events for a person based on their profession and industry',
  parameters: z.object({
    events: z.array(CalendarEvent).describe('Array of calendar events with ISO timestamps and timezone offsets'),
  }),
  strict: true,
  execute: async ({ events }) => {
    generatedEvents = events
    return { success: true, count: events.length }
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

  console.log('Testing fakeCalendarAgent with prompt:')
  console.log(userPrompt)
  
  console.log('\n=== TOOL-BASED AGENT ===\n')

  try {
    console.log('Running tool-based agent...')
    generatedEvents = [] // Reset the captured events
    const toolResult = await run(toolBasedCalendarAgent, userPrompt)
    
    console.log('Tool-based agent raw result:')
    console.log(JSON.stringify(toolResult, null, 2))
    
    // Debug step by step extraction
    console.log('\n=== DEBUGGING EXTRACTION STEP BY STEP ===')
    
    const result = toolResult as any
    console.log('1. toolResult exists:', !!result)
    console.log('2. toolResult keys:', Object.keys(result))
    console.log('3. generatedItems exists:', !!result.generatedItems)
    console.log('4. generatedItems length:', result.generatedItems?.length || 0)
    
    // Let's check all the top-level properties to see where the data might be
    console.log('\n=== INSPECTING ALL TOP-LEVEL PROPERTIES ===')
    for (const [key, value] of Object.entries(result)) {
      console.log(`${key}:`, typeof value, Array.isArray(value) ? `(array length: ${(value as any[]).length})` : '')
      if (key === 'lastProcessedResponse' || key === 'generatedItems' || key === 'finalOutput' || key === 'state') {
        console.log(`  ${key} details:`, JSON.stringify(value, null, 2).substring(0, 500) + '...')
      }
    }
    
    // Let's explore the state object specifically
    if (result.state) {
      console.log('\n=== INSPECTING STATE OBJECT ===')
      console.log('state keys:', Object.keys(result.state))
      for (const [key, value] of Object.entries(result.state)) {
        console.log(`state.${key}:`, typeof value, Array.isArray(value) ? `(array length: ${(value as any[]).length})` : '')
        if (key === '_generatedItems' || key === '_modelResponses' || key === '_lastProcessedResponse') {
          console.log(`  state.${key} details:`, JSON.stringify(value, null, 2).substring(0, 800) + '...')
        }
      }
      
      // Let's specifically check the _generatedItems array
      if (result.state._generatedItems && Array.isArray(result.state._generatedItems)) {
        console.log('\n=== INSPECTING _generatedItems ARRAY ===')
        result.state._generatedItems.forEach((item: any, index: number) => {
          console.log(`Item ${index}:`, typeof item)
          console.log(`Item ${index} keys:`, Object.keys(item))
          if (item.rawItem) {
            console.log(`Item ${index} rawItem keys:`, Object.keys(item.rawItem))
            if (item.rawItem.content) {
              console.log(`Item ${index} content length:`, item.rawItem.content.length)
              if (item.rawItem.content[0]) {
                console.log(`Item ${index} content[0] keys:`, Object.keys(item.rawItem.content[0]))
                if (item.rawItem.content[0].providerData) {
                  console.log(`Item ${index} providerData keys:`, Object.keys(item.rawItem.content[0].providerData))
                  console.log(`Item ${index} tool_calls exists:`, !!item.rawItem.content[0].providerData.tool_calls)
                }
              }
            }
          }
        })
      }
    }
    
    if (result.generatedItems?.[0]) {
      console.log('4. generatedItems[0] exists:', !!result.generatedItems[0])
      console.log('5. rawItem exists:', !!result.generatedItems[0].rawItem)
      console.log('6. content exists:', !!result.generatedItems[0].rawItem?.content)
      console.log('7. content length:', result.generatedItems[0].rawItem?.content?.length || 0)
      
      if (result.generatedItems[0].rawItem?.content?.[0]) {
        console.log('8. content[0] exists:', !!result.generatedItems[0].rawItem.content[0])
        console.log('9. content[0] type:', result.generatedItems[0].rawItem.content[0].type)
        console.log('10. providerData exists:', !!result.generatedItems[0].rawItem.content[0].providerData)
        
        if (result.generatedItems[0].rawItem.content[0].providerData) {
          const providerData = result.generatedItems[0].rawItem.content[0].providerData
          console.log('11. providerData keys:', Object.keys(providerData))
          console.log('12. tool_calls exists:', !!providerData.tool_calls)
          console.log('13. tool_calls length:', providerData.tool_calls?.length || 0)
          
          if (providerData.tool_calls?.[0]) {
            console.log('14. First tool call:', JSON.stringify(providerData.tool_calls[0], null, 2))
          }
        }
      }
    }
    
    // Try different extraction approaches based on the structure we found
    console.log('\n=== EXTRACTION ATTEMPT - MULTIPLE APPROACHES ===')
    
    let extractedEvents = null
    const generatedItems = result.state?._generatedItems || []
    
    // Approach 1: Look for direct tool call in item 0 (tool_call_item)
    const toolCallItem = generatedItems.find((item: any) => 
      item.type === 'tool_call_item' && 
      item.rawItem?.name === 'generateCalendarEvents'
    )
    
    if (toolCallItem) {
      console.log('✅ Found direct tool call item!')
      console.log('Tool call item keys:', Object.keys(toolCallItem.rawItem))
      
      try {
        const toolArgs = JSON.parse(toolCallItem.rawItem.arguments)
        extractedEvents = toolArgs.events
        console.log('✅ Successfully extracted events from direct tool call!')
      } catch (parseError) {
        console.log('❌ Error parsing direct tool call arguments:', parseError)
      }
    }
    
    // Approach 2: Look in content[0].providerData.tool_calls (original approach)
    if (!extractedEvents) {
      console.log('Trying content[0].providerData.tool_calls approach...')
      for (let i = 0; i < generatedItems.length; i++) {
        const item = generatedItems[i]
        const toolCalls = item.rawItem?.content?.[0]?.providerData?.tool_calls
        if (toolCalls && toolCalls.length > 0) {
          const calendarToolCall = toolCalls.find((call: any) => call.function?.name === 'generateCalendarEvents')
          if (calendarToolCall) {
            try {
              const toolArgs = JSON.parse(calendarToolCall.function.arguments)
              extractedEvents = toolArgs.events
              console.log(`✅ Found tool calls in item ${i}!`)
              break
            } catch (parseError) {
              console.log(`❌ Error parsing tool call in item ${i}:`, parseError)
            }
          }
        }
      }
    }
    
    // Display results
    if (extractedEvents) {
      console.log('\n✅ SUCCESS! Extracted events from tool call:')
      console.log(JSON.stringify(extractedEvents, null, 2))
      console.log(`\nGenerated ${extractedEvents.length} calendar events via tool`)
      
      // Validate that events match CalendarEvent schema
      try {
        z.array(CalendarEvent).parse(extractedEvents)
        console.log('✓ All events pass CalendarEvent validation')
      } catch (validationError) {
        console.log('✗ Events failed CalendarEvent validation:')
        console.log(validationError)
      }
    } else {
      console.log('❌ Could not extract events from any approach')
    }
    
    if (toolResult.finalOutput) {
      console.log('\nFinal output summary:')
      console.log(JSON.stringify(toolResult.finalOutput, null, 2))
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