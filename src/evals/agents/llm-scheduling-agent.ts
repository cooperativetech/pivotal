import { GoogleGenerativeAI } from '@google/generative-ai'
import type { PersonProfile, TimeSlot } from '../core-benchmark/generate-benchmark-data'
import { evaluateMeetingTime, generateRandomProfiles } from '../core-benchmark/generate-benchmark-data'
import type { PersonInput } from '../core-benchmark/score-algorithm'
import { scoreAlgorithm, printScoringResults } from '../core-benchmark/score-algorithm'

// Initialize Gemini with API key from environment
const apiKey = process.env.GOOGLE_AI_API_KEY
if (!apiKey) {
  throw new Error('GOOGLE_AI_API_KEY environment variable is required')
}
const genAI = new GoogleGenerativeAI(apiKey)
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' })

// Format person input for LLM
function formatPersonForLLM(person: PersonInput): string {
  const parts: string[] = [`${person.name}:`]
  
  // Add calendar if available
  if (person.calendar && person.calendar.length > 0) {
    parts.push('Calendar:')
    person.calendar.forEach(event => {
      parts.push(`  - ${event.start}-${event.end}: ${event.title}`)
    })
  } else {
    parts.push('Calendar: Not shared')
  }
  
  // Add raw text constraints if available
  if (person.rawText) {
    parts.push(`Constraints: ${person.rawText}`)
  }
  
  return parts.join('\n')
}

// LLM agent that picks meeting times
export async function llmSchedulingAgent(inputs: PersonInput[]): Promise<TimeSlot> {
  // Format all person inputs
  const peopleText = inputs.map(formatPersonForLLM).join('\n\n')
  
  const prompt = `Find the best 1-hour meeting time for these 5 people on Tuesday.

${peopleText}

Rules:
1. NEVER schedule during: flights, medical appointments, picking up children, emergencies
2. AVOID scheduling during: client calls, important meetings
3. OK to schedule during: focus time, work blocks, lunch (if needed)

IMPORTANT: The meeting must start at one of these times (on the hour only):
8:00, 9:00, 10:00, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00, 17:00

Think step by step:
1. Check each hour slot from 8:00 to 17:00
2. For each slot, consider who has conflicts and how important those conflicts are
3. Consider the overall impact on the group - sometimes it's better to have minor conflicts for several people than a critical conflict for one person
4. Pick the time that works best all things considered, balancing the number of free people with the severity of any conflicts

Show your reasoning, then end with "FINAL ANSWER: HH:00" (must be on the hour)`

  try {
    const result = await model.generateContent(prompt)
    const response = result.response.text().trim()
    
    console.log('\n' + '='.repeat(60))
    console.log('LLM REASONING:')
    console.log('='.repeat(60))
    console.log(response)
    console.log('='.repeat(60) + '\n')
    
    // Parse the response to extract time from FINAL ANSWER
    const finalAnswerMatch = response.match(/FINAL ANSWER:\s*(\d{1,2}):(\d{2})/i)
    const timeMatch = finalAnswerMatch || response.match(/(\d{1,2}):(\d{2})/)
    if (!timeMatch) {
      console.error('Failed to parse time from LLM response:', response)
      return { start: '10:00', end: '11:00' } // Fallback
    }
    
    const hours = parseInt(timeMatch[1])
    const minutes = parseInt(timeMatch[2])
    
    // Validate time is reasonable
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      console.error('Invalid time parsed:', hours, minutes)
      return { start: '10:00', end: '11:00' } // Fallback
    }
    
    const start = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
    const endHour = hours + 1
    const end = `${endHour.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
    
    console.log('Parsed time slot:', { start, end }) // Debug output
    
    return { start, end }
  } catch (error) {
    console.error('Error calling Gemini:', error)
    return { start: '10:00', end: '11:00' } // Fallback
  }
}

// Run evaluation using the scoring framework
export async function evaluateLLMScheduler(benchmarkFile: string, dataAvailability = { calendarProbability: 1.0, rawTextProbability: 1.0 }) {
  console.log('Evaluating LLM scheduler using benchmark data...')
  console.log(`Data availability: ${dataAvailability.calendarProbability * 100}% calendar, ${dataAvailability.rawTextProbability * 100}% rawText\n`)
  
  // Create a rate-limited version of the LLM agent
  const rateLimitedAgent = async (inputs: PersonInput[]): Promise<TimeSlot> => {
    console.log(`Processing test case with ${inputs.length} people...`)
    const result = await llmSchedulingAgent(inputs)
    
    // Validate result before returning
    if (!result || !result.start || !result.end) {
      console.error('Invalid result from LLM agent:', result)
      throw new Error('LLM agent returned invalid time slot')
    }
    
    // Add delay to respect Gemini rate limits
    // 150 RPM = 0.4 seconds between requests
    // Using 500ms to be safe
    await new Promise(resolve => setTimeout(resolve, 500))
    return result
  }
  
  try {
    const results = await scoreAlgorithm(
      'Gemini 2.5 Pro Scheduler',
      rateLimitedAgent,
      benchmarkFile,
      dataAvailability
    )
    
    printScoringResults(results)
  } catch (error) {
    console.error('Error:', error)
  }
}

// Run the evaluation
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmarkFile = process.argv[2] || 'benchmark-data-100-cases.json'
  
  // Parse optional data availability parameters
  const calendarProb = parseFloat(process.argv[3] || '1.0')
  const rawTextProb = parseFloat(process.argv[4] || '1.0')
  
  evaluateLLMScheduler(benchmarkFile, {
    calendarProbability: calendarProb,
    rawTextProbability: rawTextProb
  }).catch(console.error)
}
