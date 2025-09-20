import { Agent, run } from '../agent-sdk'

const commitSummaryAgent = new Agent({
  name: 'commitSummaryAgent',
  model: 'google/gemini-2.5-flash',
  modelSettings: {
    temperature: 0.3,
  },
  instructions: `You are a commit message generator. Given updates and diffs, generate a concise one-line summary suitable for a git commit title.

Guidelines:
- Keep it under 72 characters
- Use present tense imperative mood (e.g., "Add", "Fix", "Update", not "Added", "Fixes", "Updated")
- Be specific but concise
- Focus on the what and why, not the how
- Don't include punctuation at the end

Output ONLY the one-line summary, nothing else.`,
})

/**
 * Generate a one-line commit summary from updates and diffs
 */
export async function generateCommitSummary(updates: string, diffs: string): Promise<string> {
  const userPrompt = `Updates made:
${updates}

Git diffs:
${diffs}

Generate a concise one-line commit summary for these changes.`

  const result = await run(commitSummaryAgent, userPrompt)

  if (!result.finalOutput) {
    throw new Error('Failed to generate commit summary')
  }

  return result.finalOutput.trim()
}
