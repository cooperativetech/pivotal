import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import { Agent, run, tool } from '../agent-sdk'

const DiffOutput = z.strictObject({
  diffs: z.array(z.strictObject({
    search: z.string().describe('The exact text to search for in the file'),
    replace: z.string().describe('The text to replace it with'),
  })).describe('Array of search/replace diffs to apply to the file'),
})

const generateDiffs = tool({
  name: 'generateDiffs',
  description: 'Generate search/replace diffs to update the file based on requested changes',
  parameters: DiffOutput,
  strict: true,
  execute: (output) => output,
})

const updateFileAgent = new Agent({
  name: 'updateFileAgent',
  model: 'anthropic/claude-4.5-sonnet',
  toolUseBehavior: { stopAtToolNames: ['generateDiffs'] },
  modelSettings: {
    temperature: 0.2,
    toolChoice: 'required',
  },
  tools: [generateDiffs],
  outputType: DiffOutput,
  instructions: `You are a file update assistant. Given the current content of a file and a set of requested updates, generate search/replace diffs that will transform the file.

Guidelines:
- Create minimal, precise diffs that only change what needs to be updated
- The search string must match EXACTLY what appears in the file (including whitespace and indentation)
- Include enough context in the search string to make it unique
- For adding new content, search for an appropriate insertion point
- For removing content, replace it with an empty string or appropriate remaining content
- Break complex changes into multiple smaller diffs when appropriate
- AVOID DUPLICATE INFORMATION: Check if the content you're adding already exists in the file
- If you find duplicate information while making updates, clean it up by removing or consolidating the duplicates
- When adding new content, verify it doesn't duplicate existing sections, comments, or functionality

IMPORTANT: You must ONLY call the generateDiffs tool. Do not output any text, explanations, or commentary. Your only response should be calling the generateDiffs tool with the array of search/replace operations.`,
})

/**
 * Update a file by applying a set of changes described in natural language
 */
export async function updateFile(repoPath: string, filePath: string, updates: string): Promise<string> {
  const fullFilePath = path.join(repoPath, filePath)
  const fileContent = await fs.readFile(fullFilePath, 'utf-8')

  const userPrompt = `File: ${filePath}

Current file content:
\`\`\`
${fileContent}
\`\`\`

Updates to apply:
${updates}

Generate search/replace diffs that will apply these changes to the file.`

  const result = await run(updateFileAgent, userPrompt)

  if (!result.finalOutput) {
    throw new Error('No output generated')
  }

  // Apply the diffs to the file
  let updatedContent = fileContent
  for (const diff of result.finalOutput.diffs) {
    if (!updatedContent.includes(diff.search)) {
      throw new Error(`Search string not found in file: "${diff.search.substring(0, 50)}..."`)
    }
    updatedContent = updatedContent.replace(diff.search, diff.replace)
  }

  await fs.writeFile(fullFilePath, updatedContent)

  // Format diffs for display
  const formattedDiffs = result.finalOutput.diffs.map((diff) =>
    `${filePath}
\`\`\`
<<<<<<< ORIGINAL
${diff.search}
=======
${diff.replace}
>>>>>>> UPDATED
\`\`\``,
  ).join('\n\n')

  return formattedDiffs
}
