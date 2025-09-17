#!/usr/bin/env node

import { extractSuggestedTime } from '../../agents/evals'

// Test cases for time extraction with various formats
// All inputs should be interpreted as America/New_York timezone
// Expected outputs should be in UTC

const testCases = [
  {
    name: 'Basic meeting confirmation',
    input: 'Meeting confirmed: Thursday, January 2nd at 12:00-1:00 PM (EST)',
    expected: {
      start: '2025-01-02T17:00:00.000Z', // 12:00 PM EST = 17:00 UTC
      end: '2025-01-02T18:00:00.000Z',   // 1:00 PM EST = 18:00 UTC
      summary: 'Meeting',
    },
  },
  {
    name: 'Exclamation confirmation with participants',
    input: 'Meeting confirmed! Thursday, January 2nd from 12:00-1:00 PM (EST) with Alice and Bob.',
    expected: {
      start: '2025-01-02T17:00:00.000Z',
      end: '2025-01-02T18:00:00.000Z',
      summary: '1-hour meeting', // or similar
    },
  },
  {
    name: 'Markdown formatted announcement',
    input: 'Great! I have a time that works for both of you:\n\n**Thursday, January 2nd at 12:00-1:00 PM (EST)**\n\nAlice and Bob - please confirm this time works for your final schedules.',
    expected: {
      start: '2025-01-02T17:00:00.000Z',
      end: '2025-01-02T18:00:00.000Z',
      summary: 'Meeting',
    },
  },
  {
    name: 'Confirmation with follow-up question',
    input: 'Great! Alice has confirmed Thursday, January 2nd from 12:00-1:00 PM (EST). Bob, does this time work for you?',
    expected: {
      start: '2025-01-02T17:00:00.000Z',
      end: '2025-01-02T18:00:00.000Z',
      summary: 'Meeting',
    },
  },
  {
    name: 'Final confirmation message',
    input: 'Perfect! Your 1-hour meeting is confirmed for Thursday, January 2nd at 12:00-1:00 PM (EST). Looking forward to a productive session!',
    expected: {
      start: '2025-01-02T17:00:00.000Z',
      end: '2025-01-02T18:00:00.000Z',
      summary: '1-hour meeting',
    },
  },
  {
    name: 'Simple suggestion - tomorrow 2 PM',
    input: 'Let\'s meet at 2 PM tomorrow',
    expected: {
      start: '2025-01-02T19:00:00.000Z', // 2:00 PM EST = 19:00 UTC
      end: '2025-01-02T20:00:00.000Z',   // 3:00 PM EST = 20:00 UTC (1 hour assumed)
      summary: 'Meeting',
    },
  },
  {
    name: 'Time range suggestion',
    input: 'How about 3:30-4:30 PM on Monday?',
    expected: {
      start: '2025-01-06T20:30:00.000Z', // 3:30 PM EST = 20:30 UTC
      end: '2025-01-06T21:30:00.000Z',   // 4:30 PM EST = 21:30 UTC
      summary: 'Meeting',
    },
  },
  {
    name: 'No meeting time - multiple options',
    input: 'We could meet Monday or Tuesday',
    expected: null,
  },
  {
    name: 'No meeting time - generic message',
    input: 'Thanks for the update. Let me know when you\'re available.',
    expected: null,
  },
]

async function runTests() {
  console.log('🧪 Testing Time Extraction with America/New_York timezone')
  console.log('=' + '='.repeat(60))

  let passed = 0
  let failed = 0

  for (const testCase of testCases) {
    console.log(`\n📝 Test: ${testCase.name}`)
    console.log(`Input: "${testCase.input.slice(0, 80)}${testCase.input.length > 80 ? '...' : ''}"`)

    try {
      const result = await extractSuggestedTime(testCase.input)

      if (testCase.expected === null) {
        if (result === null) {
          console.log('✅ PASS - Correctly returned null')
          passed++
        } else {
          console.log(`❌ FAIL - Expected null but got: ${JSON.stringify(result)}`)
          failed++
        }
      } else {
        if (result === null) {
          console.log('❌ FAIL - Expected meeting time but got null')
          failed++
        } else {
          const startMatch = result.start.toISOString() === testCase.expected.start
          const endMatch = result.end.toISOString() === testCase.expected.end

          console.log(`Expected: ${testCase.expected.start} - ${testCase.expected.end}`)
          console.log(`Got:      ${result.start.toISOString()} - ${result.end.toISOString()}`)
          console.log(`Summary:  "${result.summary}"`)

          if (startMatch && endMatch) {
            console.log('✅ PASS - Times match correctly')
            passed++
          } else {
            console.log('❌ FAIL - Times do not match')
            if (!startMatch) console.log('  Start time mismatch')
            if (!endMatch) console.log('  End time mismatch')
            failed++
          }
        }
      }
    } catch (error) {
      console.log(`❌ FAIL - Error occurred: ${String(error)}`)
      failed++
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`📊 Test Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.log('❌ Some tests failed - timezone conversion may need adjustment')
    process.exit(1)
  } else {
    console.log('✅ All tests passed - time extraction working correctly')
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error)
}