import { Agent, run } from '../agent-sdk'
import { z } from 'zod'

const behaviorExpectedCheckAgent = new Agent({
  name: 'BehaviorExpectedCheckAgent',
  model: 'google/gemini-2.5-flash',
  // model: 'anthropic/claude-sonnet-4', // fallback if gemini doesn't work well
  modelSettings: {
    temperature: 0.1, // Low temperature for consistent evaluation
  },
  instructions: `You are a behavior evaluation agent. You analyze bot messages to determine if the bot's behavior matches a given expected behavior description.

    Your task is to:
    - Carefully analyze the bot's messages to understand what actions it took
    - Compare the bot's actual behavior with the expected behavior description
    - Pay special attention to scope constraints like "only", "just", "exclusively", "solely" when they limit the range of an action
    - When the expected behavior specifies a limited scope (e.g., "gather dates on January 2nd only"), the bot must not exceed that scope
    - Example: "gather calendar dates on January 2nd only" means the bot should ONLY gather dates for January 2nd, not January 2nd AND 3rd
    - Focus on precise compliance with scope limitations and behavioral requirements
    - Provide clear reasoning for your decision

    Respond in this exact format:
    REASON: [Detailed explanation of why the behavior matches or doesn't match]
    RESULT: TRUE/FALSE`,
})

const BotMessageSchema = z.object({
  text: z.string(),
  channelId: z.string().optional(),
  userId: z.string().optional(),
}).catchall(z.unknown())

type BotMessage = z.infer<typeof BotMessageSchema>

export async function checkBehaviorExpected(botMessages: BotMessage[], expectedBehavior: string): Promise<boolean> {
  // Format bot messages into a single string
  const formattedMessages = botMessages.map((message) => {
    const recipient = message.userId || message.channelId || 'unknown'
    return `To ${recipient}: ${message.text}`
  }).join('\n')

  const prompt = `Analyze the bot's messages and determine if the bot's behavior matches the expected behavior.

    Expected Behavior: "${expectedBehavior}"

    Bot Messages:
    ${formattedMessages}

    Instructions:
    - Examine what the bot actually did based on its messages
    - Compare this with the expected behavior description
    - Pay close attention to scope constraints like "only January 2nd", "just Monday", "exclusively morning", etc.
    - If the expected behavior specifies a limited scope (like "January 2nd only"), the bot must not exceed that scope
    - For example: if expected is "gather dates on January 2nd only" but bot gathers dates for "January 2nd and 3rd", this is FALSE
    - Only return TRUE if the bot's behavior exactly matches the scope and requirements specified

    Response format:
    REASON: [Detailed explanation of why the behavior matches or doesn't match]
    RESULT: TRUE/FALSE`

  try {
    const result = await run(behaviorExpectedCheckAgent, prompt)
    const response = result.finalOutput?.trim()

    if (!response) {
      console.log('🤖 No response from behavior checker')
      return false
    }

    // Parse REASON and RESULT from response
    const reasonMatch = response.match(/REASON:\s*(.+?)(?=RESULT:|$)/s)
    const resultMatch = response.match(/RESULT:\s*(TRUE|FALSE)/i)

    const reason = reasonMatch?.[1]?.trim() || 'No reason provided'
    const resultValue = resultMatch?.[1]?.trim().toUpperCase()

    // Output the reasoning to console
    console.log(`🤖 Behavior Analysis Reason: ${reason}`)

    return resultValue === 'TRUE'
  } catch (error) {
    console.error('Error checking behavior expectation with Agent:', error)
    return false
  }
}