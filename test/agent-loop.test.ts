import { describe, expect, it } from 'vitest';
import {
  Tape,
  TapeAssertion,
  TapeMismatchError,
  createAssertion,
  type Message,
  type ReplayStepResult,
  type ToolCall,
} from '../src/index.js';

const MODEL = 'gpt-4o';
const USER_PROMPT = "What's the weather in Seattle, and what is 25 * 4?";
const WEATHER_OUTPUT = { temperature: 18, condition: 'Partly Cloudy' };
const CALC_25_BY_4 = { result: 100 };
const CALC_SUM = { result: 118 };
const FINAL_ANSWER = 'Seattle is 18°C and partly cloudy. 25 * 4 = 100, and 18 + 100 = 118.';

function weatherCall(city = 'Seattle', extraArguments: Record<string, unknown> = {}): ToolCall {
  return {
    id: 'call_weather_1',
    name: 'get_weather',
    arguments: { city, units: 'celsius', ...extraArguments },
  };
}

function calcCall(expression: string, id: string): ToolCall {
  return { id, name: 'calculator', arguments: { expression } };
}

function toolMessage(callId: string, name: string, output: unknown): Message {
  return { role: 'tool', toolCallId: callId, name, content: JSON.stringify(output) };
}

function step0Messages(): Message[] {
  return [{ role: 'user', content: USER_PROMPT }];
}

function step1Messages(weather: ToolCall = weatherCall()): Message[] {
  return [
    { role: 'user', content: USER_PROMPT },
    { role: 'assistant', content: null, toolCalls: [weather, calcCall('25 * 4', 'call_calc_1')] },
    toolMessage('call_weather_1', 'get_weather', WEATHER_OUTPUT),
    toolMessage('call_calc_1', 'calculator', CALC_25_BY_4),
  ];
}

function step2Messages(weather: ToolCall = weatherCall()): Message[] {
  return [
    ...step1Messages(weather),
    { role: 'assistant', content: null, toolCalls: [calcCall('18 + 100', 'call_calc_2')] },
    toolMessage('call_calc_2', 'calculator', CALC_SUM),
  ];
}

/**
 * Record the demo tape: a 3-step agent loop that fetches the weather in
 * Seattle, computes 25 * 4, then adds the temperature to the product.
 */
function buildTape(): Tape {
  const tape = Tape.create({
    name: 'weather-calc-loop',
    description: 'Three-step weather + calculator agent loop',
    agentName: 'WeatherCalcAgent',
    tags: ['weather', 'calculator', 'demo'],
  });

  tape.record({
    input: { messages: step0Messages(), model: MODEL },
    output: {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [weatherCall(), calcCall('25 * 4', 'call_calc_1')],
      },
      finishReason: 'tool_calls',
    },
    toolResults: [
      { callId: 'call_weather_1', name: 'get_weather', output: WEATHER_OUTPUT },
      { callId: 'call_calc_1', name: 'calculator', output: CALC_25_BY_4 },
    ],
  });

  tape.record({
    input: { messages: step1Messages(), model: MODEL },
    output: {
      message: { role: 'assistant', content: null, toolCalls: [calcCall('18 + 100', 'call_calc_2')] },
      finishReason: 'tool_calls',
    },
    toolResults: [{ callId: 'call_calc_2', name: 'calculator', output: CALC_SUM }],
  });

  tape.record({
    input: { messages: step2Messages(), model: MODEL },
    output: { message: { role: 'assistant', content: FINAL_ANSWER }, finishReason: 'stop' },
  });

  return tape;
}

/**
 * Drive a generic agent loop through the assertion helper: each turn sends the
 * accumulated messages to `assertion.step` and feeds the replayed assistant
 * message plus tool results back into the next turn.
 */
function runAgentLoop(assertion: TapeAssertion): ReplayStepResult[] {
  const results: ReplayStepResult[] = [];
  const messages: Message[] = [...step0Messages()];
  while (!assertion.exhausted) {
    const result = assertion.step({ messages: [...messages], model: MODEL });
    results.push(result);
    messages.push({
      role: 'assistant',
      content: result.message.content ?? null,
      toolCalls: result.message.toolCalls,
    });
    for (const toolResult of result.toolResults) {
      messages.push(toolMessage(toolResult.callId, toolResult.name, toolResult.output));
    }
  }
  assertion.assertExhausted();
  return results;
}

function catchTapeError(fn: () => unknown): TapeMismatchError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TapeMismatchError);
    return err as TapeMismatchError;
  }
  throw new Error('Expected a TapeMismatchError to be thrown, but the call succeeded.');
}

describe('TapeAssertion agent-loop suite', () => {
  it('records a 3-step weather-and-calculator tape and asserts it step by step offline', () => {
    const tape = buildTape();
    expect(tape.length).toBe(3);

    const assertion = new TapeAssertion(tape);
    expect(assertion.matchMode).toBe('fuzzy'); // fuzzy is the default
    expect(assertion.length).toBe(3);
    expect(assertion.remaining).toBe(3);
    expect(assertion.exhausted).toBe(false);

    // Step 0: the agent asks for the weather and runs the first calculation.
    const first = assertion.step({ messages: step0Messages(), model: MODEL }, { expectedStep: 0 });
    expect(first.step).toBe(0);
    expect(first.finishReason).toBe('tool_calls');
    expect(first.message.toolCalls?.map((call) => call.name)).toEqual(['get_weather', 'calculator']);
    expect(first.message.toolCalls?.[0]?.arguments).toEqual({ city: 'Seattle', units: 'celsius' });
    expect(first.toolResults.map((result) => result.name)).toEqual(['get_weather', 'calculator']);
    expect(first.toolResults[0]?.output).toEqual(WEATHER_OUTPUT);
    expect(first.toolResults[1]?.output).toEqual(CALC_25_BY_4);

    // Step 1: after the tool results, the agent adds the temperature to the product.
    const second = assertion.step({ messages: step1Messages(), model: MODEL }, { expectedStep: 1 });
    expect(second.step).toBe(1);
    expect(second.finishReason).toBe('tool_calls');
    expect(second.message.toolCalls?.map((call) => call.arguments)).toEqual([{ expression: '18 + 100' }]);
    expect(second.toolResults[0]?.output).toEqual(CALC_SUM);

    // Step 2: the agent produces the final answer.
    const third = assertion.step({ messages: step2Messages(), model: MODEL }, { expectedStep: 2 });
    expect(third.step).toBe(2);
    expect(third.finishReason).toBe('stop');
    expect(third.message.content).toBe(FINAL_ANSWER);
    expect(third.toolResults).toEqual([]);

    assertion.assertExhausted();
    expect(assertion.exhausted).toBe(true);
    expect(assertion.remaining).toBe(0);
    expect(assertion.currentStep).toBe(3);
  });

  it('drives a full agent loop through the assertion helper and matches the recording', () => {
    const assertion = new TapeAssertion(buildTape());
    const results = runAgentLoop(assertion);

    expect(results.map((result) => result.step)).toEqual([0, 1, 2]);
    expect(results[0]?.message.toolCalls?.map((call) => call.name)).toEqual(['get_weather', 'calculator']);
    expect(results[2]?.message.content).toBe(FINAL_ANSWER);
    expect(assertion.exhausted).toBe(true);
  });

  it('replays a serialized JSON tape fixture via createAssertion with identical output', () => {
    const tape = buildTape();
    const fromMemory = runAgentLoop(new TapeAssertion(tape));

    const fixtureJson = tape.toJSON();
    const assertion = createAssertion(fixtureJson);
    expect(assertion.tape.metadata.name).toBe('weather-calc-loop');
    expect(assertion.matchMode).toBe('fuzzy');

    const fromFixture = runAgentLoop(assertion);
    expect(fromFixture.map((result) => result.message)).toEqual(fromMemory.map((result) => result.message));
    expect(fromFixture.map((result) => result.toolResults)).toEqual(
      fromMemory.map((result) => result.toolResults),
    );
  });

  it('accepts superset tool arguments by default (fuzzy) but rejects them in exact mode', () => {
    const tape = buildTape();
    const supersetWeather = weatherCall('Seattle', { options: { hourly: true } });
    const supersetMessages = step1Messages(supersetWeather);

    const fuzzy = new TapeAssertion(tape); // fuzzy by default
    fuzzy.step({ messages: step0Messages(), model: MODEL });
    const fuzzyResult = fuzzy.step({ messages: supersetMessages, model: MODEL });
    expect(fuzzyResult.step).toBe(1);

    const exact = new TapeAssertion(tape, { matchMode: 'exact' });
    exact.step({ messages: step0Messages(), model: MODEL });
    const error = catchTapeError(() => exact.step({ messages: supersetMessages, model: MODEL }));
    expect(error.reason).toBe('argument-mismatch');
  });

  it('throws a TapeMismatchError with a readable diff when tool arguments deviate', () => {
    const assertion = new TapeAssertion(buildTape());
    assertion.step({ messages: step0Messages(), model: MODEL });

    const tampered = step1Messages(weatherCall('Portland'));
    const error = catchTapeError(() => assertion.step({ messages: tampered, model: MODEL }));

    expect(error.reason).toBe('argument-mismatch');
    expect(error.step).toBe(1);
    expect(error.message).toContain('Tape mismatch at step 1');
    expect(error.message).toContain('argument-mismatch');
    expect(error.message).toContain('Seattle');
    expect(error.message).toContain('Portland');
    expect(error.mismatches[0]?.path).toBe('messages[1].toolCalls[0].arguments');
    expect(error.diff).toMatch(/^-\s.*"city": "Seattle"/m);
    expect(error.diff).toMatch(/^\+\s.*"city": "Portland"/m);

    // The failed step is not consumed: the correct input still replays.
    expect(assertion.currentStep).toBe(1);
    const recovered = assertion.step({ messages: step1Messages(), model: MODEL });
    expect(recovered.step).toBe(1);
  });

  it('rejects a wrong expectedStep hint as out-of-order without consuming the step', () => {
    const assertion = new TapeAssertion(buildTape());
    const error = catchTapeError(() =>
      assertion.step({ messages: step0Messages(), model: MODEL }, { expectedStep: 2 }),
    );
    expect(error.reason).toBe('out-of-order');
    expect(error.message).toContain('step 2');
    expect(assertion.currentStep).toBe(0);
  });

  it('exposes peek and reset without consuming steps, and flags early exhaustion', () => {
    const assertion = new TapeAssertion(buildTape());

    expect(assertion.peek()?.step).toBe(0);
    expect(assertion.peek()?.output.finishReason).toBe('tool_calls');
    expect(assertion.currentStep).toBe(0); // peek did not consume anything

    const early = catchTapeError(() => assertion.assertExhausted());
    expect(early.reason).toBe('tape-not-exhausted');
    expect(early.message).toContain('3 unplayed step(s)');

    assertion.step({ messages: step0Messages(), model: MODEL });
    expect(assertion.currentStep).toBe(1);
    expect(assertion.remaining).toBe(2);
    expect(assertion.peek()?.step).toBe(1);

    assertion.reset();
    expect(assertion.currentStep).toBe(0);
    expect(assertion.remaining).toBe(3);
    expect(assertion.peek()?.step).toBe(0);
  });

  it('throws tape-exhausted when the agent loop runs past the recording', () => {
    const assertion = new TapeAssertion(buildTape());
    runAgentLoop(assertion);
    expect(assertion.exhausted).toBe(true);

    const error = catchTapeError(() =>
      assertion.step({ messages: [{ role: 'user', content: 'one more turn?' }], model: MODEL }),
    );
    expect(error.reason).toBe('tape-exhausted');
    expect(error.message).toContain('exhausted');
    expect(error.message).toContain('3 step(s)');
  });
});
