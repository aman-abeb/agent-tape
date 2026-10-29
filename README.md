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
- **Ergonomic Assertion Suite**: `TapeAssertion` wraps a tape in an offline replay provider with fuzzy (default) or exact tool-argument matching, step-order hints, and clear diffs on unexpected agent actions.

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

## Usage

### Record once, replay forever

Capture a real agent session into a compact JSON fixture and commit it next to your tests:

```typescript
import { writeFileSync } from 'node:fs';
import { Tape } from 'agent-tape';

const tape = Tape.create({
  name: 'weather-calc-loop',
  agentName: 'WeatherCalcAgent',
  tags: ['weather', 'calculator'],
});

tape.record({
  input: {
    messages: [{ role: 'user', content: "What's the weather in Seattle, and what is 25 * 4?" }],
    model: 'gpt-4o',
  },
  output: {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call_weather_1', name: 'get_weather', arguments: { city: 'Seattle', units: 'celsius' } },
        { id: 'call_calc_1', name: 'calculator', arguments: { expression: '25 * 4' } },
      ],
    },
    finishReason: 'tool_calls',
  },
  toolResults: [
    { callId: 'call_weather_1', name: 'get_weather', output: { temperature: 18, condition: 'Partly Cloudy' } },
    { callId: 'call_calc_1', name: 'calculator', output: { result: 100 } },
  ],
});
// ...record the remaining two turns of the loop...

writeFileSync('test/fixtures/weather-calc-loop.json', tape.toJSON());
```

### Assert the agent loop offline with `TapeAssertion`

`TapeAssertion` composes a tape with an offline `ReplayProvider` so tests read like a script. Tool-argument matching defaults to `'fuzzy'` (every recorded key must match; extra keys are allowed):

```typescript
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createAssertion } from 'agent-tape';

const PROMPT = "What's the weather in Seattle, and what is 25 * 4?";
const FINAL_ANSWER = 'Seattle is 18°C and partly cloudy. 25 * 4 = 100, and 18 + 100 = 118.';

it('replays the weather-and-calculator loop offline, step by step', () => {
  const fixture = readFileSync('test/fixtures/weather-calc-loop.json', 'utf8');
  const assertion = createAssertion(fixture); // or: new TapeAssertion(tape)

  // Step 0: the agent calls get_weather and calculator.
  const step0 = assertion.step(
    { messages: [{ role: 'user', content: PROMPT }], model: 'gpt-4o' },
    { expectedStep: 0 },
  );
  expect(step0.finishReason).toBe('tool_calls');
  expect(step0.message.toolCalls?.map((call) => call.name)).toEqual(['get_weather', 'calculator']);

  // Feed step0.toolResults back into your agent loop, then assert the next turns:
  const step1 = assertion.step({ messages: afterFirstTools, model: 'gpt-4o' }, { expectedStep: 1 });
  expect(step1.message.toolCalls?.[0]?.arguments).toEqual({ expression: '18 + 100' });

  const step2 = assertion.step({ messages: afterSecondTool, model: 'gpt-4o' }, { expectedStep: 2 });
  expect(step2.message.content).toBe(FINAL_ANSWER);

  assertion.assertExhausted(); // throws if the agent stopped early or ran past the tape
});
```

Any deviation — wrong step order, missing or unexpected tool calls, or mismatched tool arguments — throws a `TapeMismatchError` with field-level mismatches and an expected-vs-actual diff:

```
Tape mismatch at step 1 (argument-mismatch) in tape "weather-calc-loop":
tool call "get_weather" (call_weather_1) arguments do not match in fuzzy mode: expected {"city":"Seattle","units":"celsius"} but received {"city":"Portland","units":"celsius"}
Field mismatches:
  - messages[1].toolCalls[0].arguments: tool call "get_weather" (call_weather_1) arguments do not match in fuzzy mode: ...
Expected vs actual diff (- expected, + actual):
-             "city": "Seattle",
+             "city": "Portland",
```

Tips:

- Pass `{ matchMode: 'exact' }` to `new TapeAssertion(tape, ...)` for strict deep-equality on tool arguments.
- Use `assertion.peek()` to inspect the next recorded step without consuming it, and `assertion.reset()` to rewind.
- `TapeAssertion.fromJSON(json)`, `TapeAssertion.fromObject(raw)`, and `createAssertion(tapeOrJson)` cover the common construction paths.

A complete, executable version of this 3-step weather-and-calculator scenario lives in `test/agent-loop.test.ts`.

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
