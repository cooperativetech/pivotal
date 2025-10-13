/**
 * Langfuse TracingExporter implementation for @openai/agents
 * Converts OpenAI agent traces and spans to Langfuse observability format
 */

import type { Langfuse } from 'langfuse'
import type {
  LangfuseTraceClient,
  LangfuseSpanClient,
  LangfuseGenerationClient,
} from 'langfuse'

import type {
  TracingExporter,
  Trace,
  Span,
} from '@openai/agents'
import type {
  SpanData,
  GenerationSpanData,
} from '@openai/agents-core/tracing/spans'

type LangfuseGenerationParams = {
  id: string
  name: string
  startTime: Date | null
  endTime: Date | null
  model: string | undefined
  modelParameters: Record<string, string | number | boolean | string[] | null> | null | undefined,
  input: unknown
  output: unknown
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  metadata: {
    rawData: Omit<GenerationSpanData, 'input' | 'output'>
    error: unknown
  }
  level: 'ERROR' | 'DEFAULT'
  statusMessage: string | undefined
}

type LangfuseSpanParams = {
  id: string
  name: string
  startTime: Date | null
  endTime: Date | null
  input: unknown
  output: unknown
  metadata: {
    rawData: Omit<SpanData, 'input' | 'output'>
    error: unknown
  }
  level: 'ERROR' | 'DEFAULT'
  statusMessage: string | undefined
}

/**
 * TracingExporter implementation that sends OpenAI agent traces to Langfuse
 */
export class LangfuseTracingExporter implements TracingExporter {
  private langfuse: Langfuse
  private enableDebugLogging: boolean

  // Maps to store traces, so that children spans can find them later
  private traceMap: Map<string, LangfuseTraceClient> = new Map()

  // Since spans are created as the nested function calls resolve, they are received
  // before their parent spans. Therefore we have to collect them and wait for the
  // parent span to be created before exporting them as children
  private spanIdToChildrenParams: Map<string, (LangfuseGenerationParams | LangfuseSpanParams)[]> = new Map()

  constructor(langfuse: Langfuse, enableDebugLogging: boolean = false) {
    this.langfuse = langfuse
    this.enableDebugLogging = enableDebugLogging
  }

  /**
   * Export traces and spans to Langfuse
   */
  async export(items: (Trace | Span<SpanData>)[], signal?: AbortSignal): Promise<void> {
    try {
      // Process items in order to maintain relationships
      for (const item of items) {
        if (signal?.aborted) {
          throw new Error('Export aborted')
        }

        if (item.type === 'trace') {
          this.exportTrace(item)
        } else if (item.type === 'trace.span') {
          this.createSpan(item)
        }
      }

      // Flush to ensure all data is sent
      await this.langfuse.flushAsync()

      if (this.enableDebugLogging) {
        console.log(`[Langfuse] Exported ${items.length} items`)
      }
    } catch (error) {
      console.error('[Langfuse] Export error:', error)
      throw error
    }
  }

  /**
   * Export a trace to Langfuse
   */
  private exportTrace(trace: Trace) {
    // Create Langfuse trace
    const langfuseTrace = this.langfuse.trace({
      id: trace.traceId,
      name: 'trace',
      sessionId: trace.groupId,
      metadata: trace.metadata,
    })

    // Store mapping
    this.traceMap.set(trace.traceId, langfuseTrace)

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created trace: ${trace.traceId}`)
    }
  }

  /**
   * Create a span for export to Langfuse
   */
  private createSpan(span: Span<SpanData>) {
    // Get parent trace or span
    const parentTrace = this.traceMap.get(span.traceId)

    // Create a default trace if none exists, which should never happen
    if (!parentTrace) {
      const defaultTraceName = 'auto-created-trace'
      const defaultTrace = this.langfuse.trace({
        id: span.traceId,
        name: defaultTraceName,
      })
      this.traceMap.set(span.traceId, defaultTrace)
    }

    // Determine if this should be a generation or regular span
    if (span.spanData.type === 'generation') {
      this.createLangfuseGeneration(span as Span<GenerationSpanData>)
    } else {
      this.createLangfuseSpan(span)
    }
  }

  /**
   * Create a Langfuse generation for LLM spans
   */
  private createLangfuseGeneration(span: Span<GenerationSpanData>) {
    const data = span.spanData

    // Try to get usage from data.output[0].usage
    const usage = (
      (Array.isArray(data.output) && data.output[0]?.usage) ?
      data.output[0].usage as {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      } : null
    )

    // Create dataWithoutIO for metadata
    const dataWithoutIO = { ...data }
    delete dataWithoutIO.input
    delete dataWithoutIO.output

    const generationParams: LangfuseGenerationParams = {
      id: span.spanId,
      name: data.type,
      startTime: span.startedAt ? new Date(span.startedAt) : null,
      endTime: span.endedAt ? new Date(span.endedAt) : null,
      model: data.model,
      modelParameters: data.model_config,
      input: data.input,
      output: data.output,
      usage: usage ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      } : undefined,
      metadata: {
        rawData: dataWithoutIO,
        error: span.error,
      },
      level: span.error ? 'ERROR' : 'DEFAULT',
      statusMessage: span.error?.message,
    }

    if (span.error?.message?.includes('Invalid output type')) {
      try {
        const serialized = typeof data.output === 'string'
          ? data.output
          : JSON.stringify(data.output)
        const preview = serialized.length > 1500 ? `${serialized.slice(0, 1500)}…` : serialized
        console.warn('[ConversationAgent] Model returned invalid structured output. Preview:', preview)
      } catch (serializationError) {
        console.warn('[ConversationAgent] Model returned invalid structured output, but output could not be serialized for logging.', serializationError)
      }
    }

    if (span.parentId) {
      // If there's a parentId, this is a child of a span, so queue to be exported later
      const parentChildren = this.spanIdToChildrenParams.get(span.parentId) || []
      parentChildren.push(generationParams)
      this.spanIdToChildrenParams.set(span.parentId, parentChildren)
    } else {
      // If no parentId, this is the direct child of the trace, so export immediately
      const parent = this.traceMap.get(span.traceId)
      if (!parent) throw new Error(`No trace found for span.traceId: ${span.traceId}`)
      this.exportSpanAndChildren(generationParams, parent)
    }

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created generation: ${span.spanId}`)
    }
  }

  /**
   * Create a Langfuse span for non-LLM spans
   */
  private createLangfuseSpan(span: Span<SpanData>) {
    const data = span.spanData
    const nameSuffix = 'name' in data ? '-' + data.name : ''

    // Create dataWithoutIO for metadata
    const dataWithoutIO = { ...data }
    if ('input' in dataWithoutIO) delete dataWithoutIO.input
    if ('output' in dataWithoutIO) delete dataWithoutIO.output

    const spanParams: LangfuseSpanParams = {
      id: span.spanId,
      name: `${data.type}${nameSuffix}`,
      startTime: span.startedAt ? new Date(span.startedAt) : null,
      endTime: span.endedAt ? new Date(span.endedAt) : null,
      input: 'input' in data ? data.input : null,
      output: 'output' in data ? data.output : null,
      metadata: {
        rawData: dataWithoutIO,
        error: span.error,
      },
      level: span.error ? 'ERROR' : 'DEFAULT',
      statusMessage: span.error?.message,
    }

    if (span.parentId) {
      // If there's a parentId, this is a child of a span, so queue to be exported later
      const parentChildren = this.spanIdToChildrenParams.get(span.parentId) || []
      parentChildren.push(spanParams)
      this.spanIdToChildrenParams.set(span.parentId, parentChildren)
    } else {
      // If no parentId, this is the direct child of the trace, so export immediately
      const parent = this.traceMap.get(span.traceId)
      if (!parent) throw new Error(`No trace found for span.traceId: ${span.traceId}`)
      // Update the trace name to match its direct child span, for readability in Tracing table
      parent.update({ name: `trace${nameSuffix}` })
      this.exportSpanAndChildren(spanParams, parent)
    }

    if (this.enableDebugLogging) {
      console.log(`[Langfuse] Created span: ${span.spanId} (${data.type})`)
    }
  }

  /**
   * Actually export the span and all of its accumulated children
   */
  private exportSpanAndChildren(
    spanParams: LangfuseGenerationParams | LangfuseSpanParams,
    parent: LangfuseTraceClient | LangfuseSpanClient | LangfuseGenerationClient,
  ) {
    const span = (
      spanParams.name === 'generation' ?
      parent.generation(spanParams) :
      parent.span(spanParams)
    )

    const childrenParams = this.spanIdToChildrenParams.get(spanParams.id) || []
    for (const childParams of childrenParams) {
      this.exportSpanAndChildren(childParams, span)
    }
    this.spanIdToChildrenParams.delete(spanParams.id)
  }
}
