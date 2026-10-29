# AgentTape

<!-- builder:badges:start -->
[![CI](https://github.com/aman-abeb/agent-tape/actions/workflows/ci.yml/badge.svg)](https://github.com/aman-abeb/agent-tape/actions/workflows/ci.yml) ![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white) ![License: MIT](https://img.shields.io/badge/license-MIT-green)
<!-- builder:badges:end -->


Deterministic record-and-replay test harness for LLM agent loops and tool-calling workflows without external API calls.

## Features

- **Deterministic Record & Replay**: Capture multi-turn LLM agent prompts, tool calls, tool results, and completions into compact JSON fixtures.
- **Strict Zod Schemas**: Comprehensive validation for messages, tool invocations, token usage, and tape metadata.
- **Zero Network Ingestion**: Replay sessions offline during continuous integration without API keys or token spend.
- **Immutable Inspection & Manipulation**: Clone, filter, and inspect tape steps programmatically.

## Quickstart

Install dependencies and build the TypeScript project:

```bash
npm install
npm run build
npm start
```

Run the test suite offline:

```bash
npm test
```

## Example

Running `npm start` executes the built CLI demo:

```
AgentTape demo executed successfully.
Recorded tape: "weather-assistant-demo" with 2 steps.
```

Code snippet:

```typescript
import { Tape } from 'agent-tape';

// 1. Create a tape fixture
const tape = Tape.create({
  name: 'weather-lookup',
  agentName: 'WeatherAssistant',
});

// 2. Record tool-calling turn
tape.record({
  input: {
    messages: [{ role: 'user', content: 'What is the temperature in Seattle?' }],
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
          arguments: { city: 'Seattle' },
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

// 3. Serialize to JSON fixture
const jsonString = tape.toJSON();

// 4. Restore and replay offline
const loaded = Tape.fromJSON(jsonString);
console.log(`Loaded ${loaded.length} steps from tape "${loaded.metadata.name}"`);
```

## How it works

AgentTape structures each interaction step into explicit `input` prompts, `output` model messages, and corresponding `toolResults`.

1. **Schema Validation**: Every entry conforms to `TapeSchema` validated by Zod at runtime.
2. **Fixture Portability**: Tapes serialize to plain JSON files that can be committed alongside test suites.
3. **Step Matching**: Replay harnesses can match inbound tool requests deterministically against tape steps and return pre-recorded responses.

## Running tests

```bash
npm test
```

<!-- builder:roadmap:start -->
## Status

**In active development:** 0 of 1 milestones done.

## Roadmap

- [ ] **Tape engine, replay provider, and agent assertion suite**: Ship the tape recording middleware, offline playback provider with fuzzy or exact argument matching, serialization schema via Zod, and executable unit tests demonstrating a 3-step weather-and-calculator agent loop.
<!-- builder:roadmap:end -->
