#!/usr/bin/env node
// NOTE: This currently generates errors

import { local_api } from '../../shared/api-client'

async function testTopicRoutingAPI(): Promise<void> {
  console.log('=== Testing Topic Routing API ===')

  try {
    // Clear database first
    console.log('\n--- Clearing database ---')
    const clearRes = await local_api.clear_test_data.$post({
      json: {},
    })
    if (clearRes.ok) {
      const clearData = await clearRes.json()
      console.log('✅ Database cleared:', clearData.message)
    } else {
      console.error('⚠️ Failed to clear database, continuing anyway')
    }

    // First, create test users
    console.log('\n--- Creating test users ---')
    const createUsersRes = await local_api.users.create_fake.$post({
      json: {
        users: [
          { id: 'TestUser1', realName: 'Test User 1', isBot: false },
          { id: 'TestUser2', realName: 'Test User 2', isBot: false },
          { id: 'TestUser3', realName: 'Test User 3', isBot: false }
        ]
      },
    })

    if (!createUsersRes.ok) {
      const errorText = await createUsersRes.text()
      console.error('❌ Failed to create users:', errorText)
      return
    }

    const { userIds } = await createUsersRes.json()
    console.log('✅ Created users:', userIds)

    // Test 1: Basic message without topicRouting
    console.log('\n--- Test 1: Basic message (ignoreExistingTopics: false) ---')
    const basicPayload = {
      userId: 'TestUser1',
      text: 'Hello, this is a test message without topic routing.',
      ignoreExistingTopics: false,
    }
    console.log('Sending payload:', JSON.stringify(basicPayload, null, 2))

    const basicRes = await local_api.message.$post({
      json: basicPayload,
    })

    if (basicRes.ok) {
      const basicData = await basicRes.json()
      console.log('✅ Success:', basicData)
    } else {
      const errorText = await basicRes.text()
      console.error('❌ Error:', basicRes.status, basicRes.statusText)
      console.error('Response body:', errorText)
    }

    // Test 2: Message with topicRouting enabled
    console.log('\n--- Test 2: Message with topic routing (ignoreExistingTopics: true) ---')
    const routingPayload = {
      userId: 'TestUser2',
      text: 'Hello, this is a test message with topic routing enabled.',
      ignoreExistingTopics: true,
    }
    console.log('Sending payload:', JSON.stringify(routingPayload, null, 2))

    const routingRes = await local_api.message.$post({
      json: routingPayload,
    })

    if (routingRes.ok) {
      const routingData = await routingRes.json()
      console.log('✅ Success:', routingData)
    } else {
      const errorText = await routingRes.text()
      console.error('❌ Error:', routingRes.status, routingRes.statusText)
      console.error('Response body:', errorText)
    }

    // Test 3: Message without ignoreExistingTopics (should default to true)
    console.log('\n--- Test 3: Message without ignoreExistingTopics field ---')
    const defaultPayload = {
      userId: 'TestUser3',
      text: 'Hello, this is a test message without the ignoreExistingTopics field.',
    }
    console.log('Sending payload:', JSON.stringify(defaultPayload, null, 2))

    const defaultRes = await local_api.message.$post({
      json: defaultPayload,
    })

    if (defaultRes.ok) {
      const defaultData = await defaultRes.json()
      console.log('✅ Success:', defaultData)
    } else {
      const errorText = await defaultRes.text()
      console.error('❌ Error:', defaultRes.status, defaultRes.statusText)
      console.error('Response body:', errorText)
    }

  } catch (error) {
    console.error('❌ Test failed with exception:', error)
  }
}

// Run the test if called directly
if (process.argv[1].endsWith('test_topic_routing.ts') || process.argv[1].endsWith('test_topic_routing.js')) {
  await testTopicRoutingAPI()
}