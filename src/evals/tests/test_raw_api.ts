import OpenAI from 'openai'

// Create direct OpenAI client to bypass Agent SDK validation
const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.PV_OPENROUTER_API_KEY,
})

async function testRawAPI() {
  console.log('Testing raw OpenAI API call...')
  const prompt = `Generate calendar events for a person's work schedule in JSON format.

Guidelines:
- Generate events mostly on weekdays, during work hours in the user's timezone
- Don't over-schedule - aim for maximum 60-70% calendar density during work hours

Return ONLY a JSON array of objects with this structure:
[
  {
    "start": "2024-01-15T09:00:00-08:00",
    "end": "2024-01-15T09:30:00-08:00",
    "summary": "Team Standup"
  }
]

Generate realistic calendar events in timezone America/New_York.
Date range: 2025-09-06T14:00:00Z to 2025-09-07T14:00:00Z
The person is an experienced software engineer working in technology.`

  try {
    const response = await client.chat.completions.create({
      model: 'anthropic/claude-4.5-sonnet',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 1,
    })

    console.log('SUCCESS! Raw API response:')
    console.log(JSON.stringify(response, null, 2))
    if (response.choices && response.choices[0]) {
      console.log('\nActual content returned by LLM:')
      console.log('---')
      console.log(response.choices[0].message.content)
      console.log('---')
    }
  } catch (error) {
    console.error('Error:', error)
    if (error instanceof Error) {
      console.error('Error details:', error.message)
    }
  }
}

// Run the test
testRawAPI().catch(console.error)
