import OpenAI from 'openai'
import {
  Agent,
  RunContext,
  run,
  tool,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  ModelBehaviorError,
} from '@openai/agents'

// Set up global agent configuration
const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.PV_OPENROUTER_API_KEY,
})
setDefaultOpenAIClient(client)
setOpenAIAPI('chat_completions')
setTracingDisabled(true)

// Re-export openai agent sdk types
export { Agent, RunContext, run, tool, ModelBehaviorError }
