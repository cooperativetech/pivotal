import { Agent, run } from '../agent-sdk'

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
    - Determine if the bot's behavior aligns with, contradicts, or is unrelated to the expectations
    - Consider partial matches - if the bot does what's expected but also does additional things, that may still count as matching
    - Focus on the core intent and requirements in the expected behavior
    - Provide clear reasoning for your decision

    Respond in this exact format:
    REASON: [Detailed explanation of why the behavior matches or doesn't match]
    RESULT: TRUE/FALSE`,
})

interface BotMessage {
  text: string
  channelId?: string
  userId?: string
  [key: string]: any
}

export async function checkBehaviorExpected(botMessages: BotMessage[], expectedBehavior: string): Promise<boolean> {
  // Format bot messages into a single string
  const formattedMessages = botMessages.map(message => {
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
    - Consider if the bot's actions align with the expectations
    - Partial matches count as TRUE if the core expectation is met (even if the bot does additional things)
    - Only return FALSE if the bot clearly contradicts the expected behavior or fails to meet the core requirement

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