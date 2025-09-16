import { Agent, run } from '../agent-sdk'

// Agent for checking if a message is confirming a meeting suggestion
export class ConfirmationCheckAgent {
  private agent: Agent

  constructor() {
    this.agent = new Agent({
      name: 'ConfirmationCheckAgent',
      model: 'anthropic/claude-sonnet-4',
      modelSettings: {
        temperature: 0.1, // Low temperature for consistent classification
      },
      instructions: `You are a confirmation detection agent. Analyze messages to determine if they contain confirmation of meeting suggestions or time proposals.

      A confirmation message can be:
      - Brief responses like "Yes", "Sounds good", "Works for me", "Perfect", "Agreed", "That works", "Confirmed"
      - Longer messages that contain clear agreement to a specific meeting time, such as "Wednesday 10:00am-11:00am works perfectly for me"
      - Messages that accept a proposed meeting time even if they include additional context or information
      - Messages that say a specific time "works", is "perfect", they "agree", they "accept", etc.
      - Messages expressing gratitude for scheduling coordination like "Thank you for coordinating this!"
      - Messages showing forward-looking acceptance like "I'm looking forward to meeting with X on [day/time]"
      - Messages that acknowledge successful scheduling even without explicit "yes"

      NOT confirmations:
      - Questions about meeting times
      - Counter-proposals suggesting different times
      - Requests for clarification
      - Messages that don't reference a specific meeting time or proposal

      Respond with exactly "TRUE" for confirmations, "FALSE" otherwise.`,
    })
  }

  async isConfirming(messageText: string): Promise<boolean> {
    const prompt = `Analyze this message and determine if it contains confirmation or acceptance of a meeting suggestion or time proposal.

      Message: "${messageText}"

      Look for:
      - Explicit agreement to a specific meeting time
      - Phrases indicating acceptance like "works for me", "perfect", "sounds good", "I agree", "that works"
      - Confirmation of a proposed time slot even if surrounded by other text

      Response format:
      - If this message confirms or accepts a meeting time: Return "TRUE"
      - Otherwise: Return "FALSE"`

    try {
      const result = await run(this.agent, prompt)
      const response = result.finalOutput?.trim().toUpperCase()
      return response === 'TRUE'
    } catch (error) {
      console.error('Error checking confirmation with Agent:', error)
      return false
    }
  }
}

// Create singleton instance for reuse
export const confirmationCheckAgent = new ConfirmationCheckAgent()