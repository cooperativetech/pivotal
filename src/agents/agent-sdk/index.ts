import OpenAI from 'openai'
import {
  Agent,
  Runner,
  run,
  tool,
  BatchTraceProcessor,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTraceProcessors,
} from '@openai/agents'
import type { AgentOptions, RunContext } from '@openai/agents'
import { Langfuse } from 'langfuse'

import { LangfuseTracingExporter } from './langfuse-tracing-exporter'

// Set up global agent configuration
const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.PV_OPENROUTER_API_KEY,
})

// Set up langfuse for tracing
const langfuse = new Langfuse({
  publicKey: process.env.PV_LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.PV_LANGFUSE_SECRET_KEY,
  baseUrl: process.env.PV_LANGFUSE_BASE_URL,
})

const tracingExporter = new LangfuseTracingExporter(langfuse)
const traceProcessor = new BatchTraceProcessor(tracingExporter, { maxBatchSize: 1 })

setDefaultOpenAIClient(client)
setOpenAIAPI('chat_completions')
setTraceProcessors([traceProcessor])

// Re-export openai agent sdk types
export type { AgentOptions, RunContext }
export { Agent, Runner, run, tool }
