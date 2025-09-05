import { z } from 'zod'
import { Agent, run } from '../../agents/agent-sdk'

// Create the simplest possible agent to test if API calls work
const basicAgent = new Agent({
  name: 'basicAgent',
  model: 'anthropic/claude-sonnet-4',
  //outputType: z.string(), // Just expect a string output
  instructions: 'You are a helpful assistant. Just respond with a simple greeting.',
})

async function testBasicAgent() {
  console.log('Testing basic agent with simple string output...')
  
  try {
    const result = await run(basicAgent, 'Say hello')
    
    console.log('Success! Raw result:')
    console.log(JSON.stringify(result, null, 2))
    
    if (result.finalOutput) {
      console.log('\nFinal output:')
      console.log(result.finalOutput)
    }
  } catch (error) {
    console.error('Error:', error)
    if (error instanceof Error) {
      console.error('Error details:', error.message)
    }
  }
}

// Run the test
testBasicAgent().catch(console.error)