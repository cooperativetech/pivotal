import {
  type PersonProfile,
  type CalendarEvent,
  type UtilityConfig,
  type TimeSlot,
  type EvaluationResult,
  evaluateMeetingTime,
  generateAllTimeSlots,
  calculateTotalUtility,
  minutesToTime,
} from './scheduling-eval'

// Configuration for random calendar generation
interface CalendarGenerationConfig {
  minEvents: number
  maxEvents: number
  eventTypeProbabilities: {
    meeting: number
    blockedWork: number
    personal: number
    critical: number
  }
  // Working hours (in minutes from midnight)
  workdayStart: number // e.g., 480 for 8:00
  workdayEnd: number   // e.g., 1080 for 18:00
}

// Generate a random calendar for one person
function generateRandomCalendar(config: CalendarGenerationConfig): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const numEvents = Math.floor(Math.random() * (config.maxEvents - config.minEvents + 1)) + config.minEvents
  
  // Track occupied time slots to avoid overlaps
  const occupiedSlots = new Set<string>()
  
  for (let i = 0; i < numEvents; i++) {
    let attempts = 0
    let event: CalendarEvent | null = null
    
    // Try to create non-overlapping event (max 50 attempts)
    while (attempts < 50 && !event) {
      // Random start time within working hours
      const startMinutes = Math.floor(
        Math.random() * (config.workdayEnd - config.workdayStart - 60) + config.workdayStart
      )
      
      // Round to nearest 30 minutes
      const roundedStart = Math.floor(startMinutes / 30) * 30
      
      // Random duration: 30, 60, or 90 minutes
      const duration = [30, 60, 90][Math.floor(Math.random() * 3)]
      const endMinutes = roundedStart + duration
      
      // Check if this slot is available
      const slotKey = `${roundedStart}-${endMinutes}`
      if (!occupiedSlots.has(slotKey) && endMinutes <= config.workdayEnd) {
        // Mark all overlapping 30-min slots as occupied
        for (let m = roundedStart; m < endMinutes; m += 30) {
          occupiedSlots.add(`${m}-${m + 30}`)
        }
        
        // Determine event type based on probabilities
        const rand = Math.random()
        let eventType: 'meeting' | 'blocked-work' | 'personal' | 'critical'
        const probs = config.eventTypeProbabilities
        
        if (rand < probs.critical) {
          eventType = 'critical'
        } else if (rand < probs.critical + probs.personal) {
          eventType = 'personal'
        } else if (rand < probs.critical + probs.personal + probs.blockedWork) {
          eventType = 'blocked-work'
        } else {
          eventType = 'meeting'
        }
        
        // Generate description based on type
        const descriptions = {
          meeting: ['Team sync', 'Client call', '1:1', 'Planning session', 'Review meeting'],
          'blocked-work': ['Focus time', 'Deep work', 'Project work', 'Code review', 'Documentation'],
          personal: ['Lunch', 'Gym', 'Errand', 'Appointment', 'Break'],
          critical: ['Pick up kids', 'Medical appointment', 'Flight', 'School event', 'Emergency'],
        }
        
        event = {
          start: minutesToTime(roundedStart),
          end: minutesToTime(endMinutes),
          type: eventType,
          description: descriptions[eventType][Math.floor(Math.random() * descriptions[eventType].length)],
        }
      }
      
      attempts++
    }
    
    if (event) {
      events.push(event)
    }
  }
  
  // Sort events by start time
  events.sort((a, b) => {
    const aStart = parseInt(a.start.split(':')[0]) * 60 + parseInt(a.start.split(':')[1])
    const bStart = parseInt(b.start.split(':')[0]) * 60 + parseInt(b.start.split(':')[1])
    return aStart - bStart
  })
  
  return events
}

// Generate random utility configuration with some variation
function generateRandomUtilityConfig(): UtilityConfig {
  // Base utilities with some random variation
  return {
    free: 100, // Always max
    blockedWork: 60 + Math.floor(Math.random() * 20), // 60-80
    meeting: 10 + Math.floor(Math.random() * 20), // 10-30
    personal: 30 + Math.floor(Math.random() * 20), // 30-50
    critical: 0, // Always min
  }
}

// Generate N random person profiles
export function generateRandomProfiles(
  numPeople: number,
  calendarConfig?: Partial<CalendarGenerationConfig>
): PersonProfile[] {
  const defaultConfig: CalendarGenerationConfig = {
    minEvents: 3,
    maxEvents: 8,
    eventTypeProbabilities: {
      meeting: 0.4,
      blockedWork: 0.3,
      personal: 0.2,
      critical: 0.1,
    },
    workdayStart: 8 * 60, // 8:00
    workdayEnd: 18 * 60,  // 18:00
  }
  
  const config = { ...defaultConfig, ...calendarConfig }
  
  const names = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack',
    'Kate', 'Liam', 'Maya', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Ruby', 'Sam', 'Tara',
  ]
  
  const profiles: PersonProfile[] = []
  
  for (let i = 0; i < numPeople; i++) {
    profiles.push({
      name: names[i % names.length] + (i >= names.length ? i.toString() : ''),
      calendar: generateRandomCalendar(config),
      utilityConfig: generateRandomUtilityConfig(),
    })
  }
  
  return profiles
}

// Simple scheduling algorithm to test
// This is a basic algorithm that tries common meeting times
export function simpleSchedulingAlgorithm(profiles: PersonProfile[]): TimeSlot {
  // Common meeting time preferences (in order of preference)
  const preferredTimes: TimeSlot[] = [
    { start: '10:00', end: '11:00' }, // Mid-morning
    { start: '14:00', end: '15:00' }, // Early afternoon
    { start: '11:00', end: '12:00' }, // Late morning
    { start: '15:00', end: '16:00' }, // Mid-afternoon
    { start: '09:00', end: '10:00' }, // Early morning
    { start: '16:00', end: '17:00' }, // Late afternoon
    { start: '13:00', end: '14:00' }, // After lunch
  ]
  
  // Evaluate each preferred time and pick the best
  let bestSlot = preferredTimes[0]
  let bestUtility = -Infinity
  
  for (const slot of preferredTimes) {
    const { total } = calculateTotalUtility(profiles, slot)
    if (total > bestUtility) {
      bestUtility = total
      bestSlot = slot
    }
  }
  
  return bestSlot
}

// More sophisticated algorithm that considers all slots
export function greedySchedulingAlgorithm(profiles: PersonProfile[]): TimeSlot {
  const allSlots = generateAllTimeSlots()
  let bestSlot = allSlots[0]
  let bestUtility = -Infinity
  
  for (const slot of allSlots) {
    const { total } = calculateTotalUtility(profiles, slot)
    if (total > bestUtility) {
      bestUtility = total
      bestSlot = slot
    }
  }
  
  return bestSlot
}

// Algorithm that uses heuristics (e.g., avoid early/late, prefer mid-day)
export function heuristicSchedulingAlgorithm(profiles: PersonProfile[]): TimeSlot {
  const allSlots = generateAllTimeSlots()
  
  // Filter to reasonable meeting hours (9-17)
  const reasonableSlots = allSlots.filter(slot => {
    const hour = parseInt(slot.start.split(':')[0])
    return hour >= 9 && hour < 17
  })
  
  // Score each slot with utility + time preference bonus
  let bestSlot = reasonableSlots[0]
  let bestScore = -Infinity
  
  for (const slot of reasonableSlots) {
    const { total } = calculateTotalUtility(profiles, slot)
    const hour = parseInt(slot.start.split(':')[0])
    
    // Add bonus for preferred times (10-11, 14-16)
    let timeBonus = 0
    if (hour === 10 || hour === 14 || hour === 15) {
      timeBonus = 50 // Significant bonus for preferred times
    }
    
    const score = total + timeBonus
    if (score > bestScore) {
      bestScore = score
      bestSlot = slot
    }
  }
  
  return bestSlot
}

// Evaluation result for a single test case
interface TestCaseResult {
  optimalSlot: TimeSlot
  optimalUtility: number
  algorithmSlot: TimeSlot
  algorithmUtility: number
  isOptimal: boolean
  utilityRatio: number // algorithmUtility / optimalUtility
  percentile: number
}

// Benchmark results summary
interface BenchmarkResults {
  algorithmName: string
  totalCases: number
  optimalCount: number
  optimalRate: number
  averageUtilityRatio: number
  averagePercentile: number
  worstCaseRatio: number
  percentileDistribution: {
    top10: number    // >= 90th percentile
    top25: number    // >= 75th percentile
    top50: number    // >= 50th percentile
    bottom25: number // < 25th percentile
  }
}

// Run a single test case
function runTestCase(
  profiles: PersonProfile[],
  algorithm: (profiles: PersonProfile[]) => TimeSlot
): TestCaseResult {
  // Find the optimal solution
  const allSlots = generateAllTimeSlots()
  let optimalSlot = allSlots[0]
  let optimalUtility = -Infinity
  
  for (const slot of allSlots) {
    const { total } = calculateTotalUtility(profiles, slot)
    if (total > optimalUtility) {
      optimalUtility = total
      optimalSlot = slot
    }
  }
  
  // Run the algorithm
  const algorithmSlot = algorithm(profiles)
  const { total: algorithmUtility } = calculateTotalUtility(profiles, algorithmSlot)
  
  // Get percentile
  const evaluation = evaluateMeetingTime(profiles, algorithmSlot)
  
  return {
    optimalSlot,
    optimalUtility,
    algorithmSlot,
    algorithmUtility,
    isOptimal: algorithmUtility === optimalUtility,
    utilityRatio: algorithmUtility / optimalUtility,
    percentile: evaluation.percentile,
  }
}

// Run benchmark with N test cases
export function runBenchmark(
  algorithmName: string,
  algorithm: (profiles: PersonProfile[]) => TimeSlot,
  numCases: number,
  numPeoplePerCase: number = 5,
  calendarConfig?: Partial<CalendarGenerationConfig>
): BenchmarkResults {
  const results: TestCaseResult[] = []
  
  console.log(`Running ${numCases} test cases for ${algorithmName}...`)
  
  for (let i = 0; i < numCases; i++) {
    if (i % 100 === 0 && i > 0) {
      console.log(`  Progress: ${i}/${numCases} cases completed`)
    }
    
    const profiles = generateRandomProfiles(numPeoplePerCase, calendarConfig)
    const result = runTestCase(profiles, algorithm)
    results.push(result)
  }
  
  // Calculate statistics
  const optimalCount = results.filter(r => r.isOptimal).length
  const averageUtilityRatio = results.reduce((sum, r) => sum + r.utilityRatio, 0) / results.length
  const averagePercentile = results.reduce((sum, r) => sum + r.percentile, 0) / results.length
  const worstCaseRatio = Math.min(...results.map(r => r.utilityRatio))
  
  // Percentile distribution
  const percentileDistribution = {
    top10: results.filter(r => r.percentile >= 90).length,
    top25: results.filter(r => r.percentile >= 75).length,
    top50: results.filter(r => r.percentile >= 50).length,
    bottom25: results.filter(r => r.percentile < 25).length,
  }
  
  // Debug: Check if percentiles are being calculated correctly
  if (results.length > 0) {
    const samplePercentiles = results.slice(0, 5).map(r => r.percentile)
    console.log(`  Sample percentiles: ${samplePercentiles.map(p => p.toFixed(1)).join(', ')}`)
  }
  
  return {
    algorithmName,
    totalCases: numCases,
    optimalCount,
    optimalRate: optimalCount / numCases,
    averageUtilityRatio,
    averagePercentile,
    worstCaseRatio,
    percentileDistribution,
  }
}

// Format benchmark results for display
export function formatBenchmarkResults(results: BenchmarkResults): string {
  const output = [
    `\nBenchmark Results: ${results.algorithmName}`,
    '='.repeat(50),
    `Total test cases: ${results.totalCases}`,
    '',
    `🎯 AVERAGE PERCENTILE: ${results.averagePercentile.toFixed(1)}%`,
    `   (Higher is better - 50% means median performance)`,
    '',
    'Percentile Distribution:',
    `  Top 10% (≥90th percentile): ${results.percentileDistribution.top10} (${(results.percentileDistribution.top10 / results.totalCases * 100).toFixed(1)}%)`,
    `  Top 25% (≥75th percentile): ${results.percentileDistribution.top25} (${(results.percentileDistribution.top25 / results.totalCases * 100).toFixed(1)}%)`,
    `  Top 50% (≥50th percentile): ${results.percentileDistribution.top50} (${(results.percentileDistribution.top50 / results.totalCases * 100).toFixed(1)}%)`,
    `  Bottom 25% (<25th percentile): ${results.percentileDistribution.bottom25} (${(results.percentileDistribution.bottom25 / results.totalCases * 100).toFixed(1)}%)`,
    '',
    'Additional metrics:',
    `  Times optimal found: ${results.optimalCount} (${(results.optimalRate * 100).toFixed(1)}%)`,
    `  Average utility ratio: ${(results.averageUtilityRatio * 100).toFixed(1)}%`,
    `  Worst case ratio: ${(results.worstCaseRatio * 100).toFixed(1)}%`,
  ]
  
  return output.join('\n')
}

// Run all benchmarks
export function runAllBenchmarks(numCases: number = 1000) {
  console.log(`Starting scheduling algorithm benchmarks with ${numCases} test cases each...\n`)
  
  // Test different algorithms
  const algorithms: Array<{ name: string; fn: (profiles: PersonProfile[]) => TimeSlot }> = [
    { name: 'Simple Algorithm (Common Times)', fn: simpleSchedulingAlgorithm },
    { name: 'Greedy Algorithm (Exhaustive)', fn: greedySchedulingAlgorithm },
    { name: 'Heuristic Algorithm (Smart)', fn: heuristicSchedulingAlgorithm },
  ]
  
  const allResults: BenchmarkResults[] = []
  
  for (const { name, fn } of algorithms) {
    const results = runBenchmark(name, fn, numCases)
    allResults.push(results)
    console.log(formatBenchmarkResults(results))
  }
  
  // Compare algorithms
  console.log('\n' + '='.repeat(50))
  console.log('Algorithm Comparison Summary:')
  console.log('='.repeat(50))
  
  // Sort by average percentile (higher is better)
  allResults.sort((a, b) => b.averagePercentile - a.averagePercentile)
  
  console.log('\nRanked by Average Percentile (key metric):')
  allResults.forEach((result, index) => {
    console.log(`${index + 1}. ${result.algorithmName}: ${result.averagePercentile.toFixed(1)}%`)
  })
  
  // Analysis
  const bestPercentile = Math.max(...allResults.map(r => r.averagePercentile))
  const worstPercentile = Math.min(...allResults.map(r => r.averagePercentile))
  
  console.log(`\nKey Insights:`)
  console.log(`- Best average percentile: ${bestPercentile.toFixed(1)}%`)
  console.log(`- Worst average percentile: ${worstPercentile.toFixed(1)}%`)
  console.log(`- Performance gap: ${(bestPercentile - worstPercentile).toFixed(1)} percentile points`)
  
  // Show which algorithms are close to random (33.3% for 3 algorithms)
  const randomExpectedPercentile = 100 / allResults.length
  console.log(`\nNote: Random selection would average ${randomExpectedPercentile.toFixed(1)}% percentile`)
}