import { fileURLToPath } from 'node:url';
import { ReplayProvider } from './replay.js';
import { Tape } from './tape.js';

export * from './schema.js';
export * from './tape.js';
export * from './replay.js';
export * from './assert.js';

/**
 * Demo function demonstrating tape recording, validation, JSON export, and offline replay.
 */
export function runDemo(): void {
  const tape = Tape.create({
    name: 'weather-assistant-demo',
    description: 'Demonstration recording of a multi-turn agent interaction',
    agentName: 'WeatherBot',
    tags: ['demo', 'weather'],
  });

  tape.record({
    input: {
      messages: [{ role: 'user', content: 'What is the weather in Seattle?' }],
      model: 'gpt-4o',
    },
    output: {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_weather',
            arguments: { city: 'Seattle', units: 'celsius' },
          },
        ],
      },
      finishReason: 'tool_calls',
    },
    toolResults: [
      {
        callId: 'call_1',
        name: 'get_weather',
        output: { temperature: 18, condition: 'Partly Cloudy' },
      },
    ],
  });

  tape.record({
    input: {
      messages: [
        { role: 'user', content: 'What is the weather in Seattle?' },
        {
          role: 'assistant',
          toolCalls: [
            {
              id: 'call_1',
              name: 'get_weather',
              arguments: { city: 'Seattle', units: 'celsius' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          name: 'get_weather',
          content: JSON.stringify({ temperature: 18, condition: 'Partly Cloudy' }),
        },
      ],
      model: 'gpt-4o',
    },
    output: {
      message: {
        role: 'assistant',
        content: 'The weather in Seattle is currently 18°C and partly cloudy.',
      },
      finishReason: 'stop',
    },
  });

  // Replay the recorded tape fully offline to prove deterministic playback.
  const replay = new ReplayProvider(tape);
  const firstTurn = replay.step({
    messages: [{ role: 'user', content: 'What is the weather in Seattle?' }],
    model: 'gpt-4o',
  });
  const secondTurn = replay.step({
    messages: [
      { role: 'user', content: 'What is the weather in Seattle?' },
      { role: 'assistant', toolCalls: firstTurn.message.toolCalls },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'get_weather',
        content: JSON.stringify({ temperature: 18, condition: 'Partly Cloudy' }),
      },
    ],
    model: 'gpt-4o',
  });
  replay.assertExhausted();
  if (secondTurn.message.content !== 'The weather in Seattle is currently 18°C and partly cloudy.') {
    throw new Error('Replayed tape did not reproduce the recorded demo output.');
  }

  process.stdout.write(`AgentTape demo executed successfully.\n`);
  process.stdout.write(`Recorded tape: "${tape.metadata.name}" with ${tape.length} steps.\n`);
}

// Run demo if this file is executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDemo();
}
