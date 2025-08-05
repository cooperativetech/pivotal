# Scheduling Evaluation Framework

## Quick Start

```bash
# Test the LLM scheduler with existing benchmark data
export GOOGLE_AI_API_KEY="your-api-key"
npx tsx agents/llm-scheduling-agent.ts data/benchmark-data-100-cases.json

# Test with partial data (70% calendars, 90% raw text)
npx tsx agents/llm-scheduling-agent.ts data/benchmark-data-100-cases.json 0.7 0.9

# Generate new benchmark data
npx tsx core-benchmark/generate-benchmark-data.ts 100
```

## Creating & Scoring Your Algorithm

```typescript
import { scoreAlgorithm, printScoringResults } from './core-benchmark/score-algorithm'
import type { PersonInput, TimeSlot } from './core-benchmark/score-algorithm'

// Create your scheduling function
async function myScheduler(inputs: PersonInput[]): Promise<TimeSlot> {
  // inputs: Array of people with calendar events and/or raw text constraints
  // Return a 1-hour meeting slot (must start on the hour)
  return { start: "14:00", end: "15:00" }
}

// Score it against benchmark data
const results = await scoreAlgorithm(
  'My Algorithm Name',
  myScheduler,
  'data/benchmark-data-100-cases.json'
)
printScoringResults(results)
```

**Input format:**
- `PersonInput[]` - Array of people with optional calendar events and raw text availability
- Calendar events have start/end times (24hr format) and title/description
- Raw text contains natural language constraints

**Output format:**
- `TimeSlot` - Single 1-hour slot with start/end times
- Must start on the hour (8:00, 9:00, ... 17:00)

## Files

**core-benchmark/**
- `generate-benchmark-data.ts` - Creates test cases with random calendars and hidden utility values
- `score-algorithm.ts` - Framework for scoring scheduling algorithms against benchmark data

**agents/**
- `llm-scheduling-agent.ts` - Example scheduler using Google Gemini to find optimal meeting times

**data/**
- `benchmark-data-*.json` - Pre-generated test cases for evaluation