import { describe, expect, it } from 'vitest';
import {
  ReplayProvider,
  Tape,
  TapeMismatchError,
  type Message,
  type ReplayStepResult,
  type ToolCall,
} from '../src/index.js';

const MODEL = 'gpt-4o';
const USER_PROMPT = "What's the weather in Seattle, and what is 25 * 4?";
const WEATHER_OUTPUT = { temperature: 18, condition: 'Partly Cloudy' };
const CALC_OUTPUT_1 = { result: 100 };
const CALC_OUTPUT_2 = { result: 118 };
const FINAL_ANSWER = 'Seattle is 18°C and partly cloudy. 25 * 4 = 100, and 18 + 100 = 118.';

function weatherCall(): ToolCall {
  return { id: 'call_weather_1', name: 'get_weather', arguments: { city: 'Seattle', units: 'celsius' } };
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

function step1Messages(): Message[] {
  return [
    { role: 'user', content: USER_PROMPT },
    { role: 'assistant', content: null, toolCalls: [weatherCall(), calcCall('25 * 4', 'call_calc_1')] },
    toolMessage('call_weather_1', 'get_weather', WEATHER_OUTPUT),
    toolMessage('call_calc_1', 'calculator', CALC_OUTPUT_1),
  ];
}

function step2Messages(): Message[] {
  return [
    ...step1Messages(),
    { role: 'assistant', content: null, toolCalls: [calcCall('18 + 100', 'call_calc_2')] },
    toolMessage('call_calc_2', 'calculator', CALC_OUTPUT_2),
  ];
}

function buildTape(): Tape {
  const tape = Tape.create({
    name: 'weather-calc-loop',
    description: 'Three-step weather + calculator agent loop',
    agentName: 'WeatherCalcAgent',
    tags: ['weather', 'calculator', 'replay'],
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
      { callId: 'call_calc_1', name: 'calculator', output: CALC_OUTPUT_1 },
    ],
  });

  tape.record({
    input: { messages: step1Messages(), model: MODEL },
    output: {
      message: { role: 'assistant', content: null, toolCalls: [calcCall('18 + 100', 'call_calc_2')] },
      finishReason: 'tool_calls',
    },
    toolResults: [{ callId: 'call_calc_2', name: 'calculator', output: CALC_OUTPUT_2 }],
  });

  tape.record({
    input: { messages: step2Messages(), model: MODEL },
    output: { message: { role: 'assistant', content: FINAL_ANSWER }, finishReason: 'stop' },
  });

  return tape;
}

function runAgentLoop(provider: ReplayProvider): ReplayStepResult[] {
  const results: ReplayStepResult[] = [];
  const messages: Message[] = [...step0Messages()];
  while (!provider.exhausted) {
    const result = provider.step({ messages: [...messages], model: MODEL });
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

describe('ReplayProvider', () => {
  it('replays a 3-step weather-and-calculator agent loop step by step', () => {
    const provider = new ReplayProvider(buildTape());
    expect(provider.matchMode).toBe('exact');
    expect(provider.length).toBe(3);
    expect(provider.remaining).toBe(3);
    expect(provider.exhausted).toBe(false);
    expect(provider.peek()?.step).toBe(0);

    const results = runAgentLoop(provider);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.step)).toEqual([0, 1, 2]);

    expect(results[0]!.finishReason).toBe('tool_calls');
    expect(results[0]!.message.toolCalls?.map((c) => c.name)).toEqual(['get_weather', 'calculator']);
    expect(results[0]!.toolResults.map((t) => t.callId)).toEqual(['call_weather_1', 'call_calc_1']);
    expect(results[0]!.toolResults[0]!.output).toEqual(WEATHER_OUTPUT);

    expect(results[1]!.finishReason).toBe('tool_calls');
    expect(results[1]!.message.toolCalls?.[0]?.arguments).toEqual({ expression: '18 + 100' });
    expect(results[1]!.toolResults[0]!.output).toEqual(CALC_OUTPUT_2);

    expect(results[2]!.finishReason).toBe('stop');
    expect(results[2]!.message.content).toBe(FINAL_ANSWER);
    expect(results[2]!.toolResults).toEqual([]);

    expect(provider.exhausted).toBe(true);
    expect(provider.remaining).toBe(0);
    expect(provider.currentStep).toBe(3);
    expect(() => provider.assertExhausted()).not.toThrow();
  });

  it('produces identical playback from a serialized JSON tape fixture', () => {
    const tape = buildTape();
    const fromMemory = runAgentLoop(new ReplayProvider(tape));
    const fromJson = runAgentLoop(ReplayProvider.fromJSON(tape.toJSON()));
    expect(fromJson.map((r) => r.message)).toEqual(fromMemory.map((r) => r.message));
    expect(fromJson.map((r) => r.toolResults)).toEqual(fromMemory.map((r) => r.toolResults));
  });

  it('accepts a bare message array as the step request', () => {
    const tape = Tape.create({ name: 'bare-messages' });
    tape.record({
      input: { messages: [{ role: 'user', content: 'ping' }] },
      output: { message: { role: 'assistant', content: 'pong' }, finishReason: 'stop' },
    });
    const provider = new ReplayProvider(tape);
    const result = provider.step([{ role: 'user', content: 'ping' }]);
    expect(result.step).toBe(0);
    expect(result.message.content).toBe('pong');
    expect(provider.exhausted).toBe(true);
  });

  it('rejects argument mismatches in exact mode with a readable expected-vs-actual diff', () => {
    const provider = new ReplayProvider(buildTape(), { matchMode: 'exact' });
    provider.step({ messages: step0Messages(), model: MODEL });

    const tampered: Message[] = [
      { role: 'user', content: USER_PROMPT },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_weather_1', name: 'get_weather', arguments: { city: 'Portland', units: 'celsius' } },
          calcCall('25 * 4', 'call_calc_1'),
        ],
      },
      toolMessage('call_weather_1', 'get_weather', WEATHER_OUTPUT),
      toolMessage('call_calc_1', 'calculator', CALC_OUTPUT_1),
    ];

    const error = catchTapeError(() => provider.step({ messages: tampered, model: MODEL }));
    expect(error.reason).toBe('argument-mismatch');
    expect(error.step).toBe(1);
    expect(error.message).toContain('step 1');
    expect(error.message).toContain('Portland');
    expect(error.message).toContain('Seattle');
    expect(error.mismatches[0]?.path).toBe('messages[1].toolCalls[0].arguments');
    expect(error.diff).toMatch(/^-\s.*"city": "Seattle"/m);
    expect(error.diff).toMatch(/^\+\s.*"city": "Portland"/m);

    // The failed step is not consumed: replaying the correct input still works.
    expect(provider.currentStep).toBe(1);
    const recovered = provider.step({ messages: step1Messages(), model: MODEL });
    expect(recovered.step).toBe(1);
  });

  it('accepts superset tool arguments in fuzzy mode but rejects them in exact mode', () => {
    const tape = Tape.create({ name: 'fuzzy-args' });
    tape.record({
      input: { messages: [{ role: 'user', content: 'Weather in Seattle?' }] },
      output: {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Seattle' } }],
        },
        finishReason: 'tool_calls',
      },
      toolResults: [{ callId: 'c1', name: 'get_weather', output: { temperature: 18 } }],
    });
    tape.record({
      input: {
        messages: [
          { role: 'user', content: 'Weather in Seattle?' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Seattle' } }],
          },
          toolMessage('c1', 'get_weather', { temperature: 18 }),
        ],
      },
      output: { message: { role: 'assistant', content: '18°C in Seattle.' }, finishReason: 'stop' },
    });

    const supersetMessages: Message[] = [
      { role: 'user', content: 'Weather in Seattle?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'c1',
            name: 'get_weather',
            arguments: { city: 'Seattle', units: 'celsius', options: { hourly: true } },
          },
        ],
      },
      toolMessage('c1', 'get_weather', { temperature: 18 }),
    ];

    const fuzzy = new ReplayProvider(tape, { matchMode: 'fuzzy' });
    fuzzy.step({ messages: [{ role: 'user', content: 'Weather in Seattle?' }] });
    const fuzzyResult = fuzzy.step({ messages: supersetMessages });
    expect(fuzzyResult.step).toBe(1);
    expect(fuzzyResult.message.content).toBe('18°C in Seattle.');

    const exact = new ReplayProvider(tape, { matchMode: 'exact' });
    exact.step({ messages: [{ role: 'user', content: 'Weather in Seattle?' }] });
    const exactError = catchTapeError(() => exact.step({ messages: supersetMessages }));
    expect(exactError.reason).toBe('argument-mismatch');

    const wrongValue: Message[] = [
      { role: 'user', content: 'Weather in Seattle?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Portland', units: 'celsius' } }],
      },
      toolMessage('c1', 'get_weather', { temperature: 18 }),
    ];
    const fuzzyStrict = new ReplayProvider(tape, { matchMode: 'fuzzy' });
    fuzzyStrict.step({ messages: [{ role: 'user', content: 'Weather in Seattle?' }] });
    const valueError = catchTapeError(() => fuzzyStrict.step({ messages: wrongValue }));
    expect(valueError.reason).toBe('argument-mismatch');
  });

  it('detects out-of-order and skipped steps', () => {
    const provider = new ReplayProvider(buildTape());

    // Feeding step-2 messages while the cursor is at step 0 is a mismatch.
    const skipped = catchTapeError(() => provider.step({ messages: step2Messages(), model: MODEL }));
    expect(skipped.reason).toBe('input-mismatch');
    expect(skipped.message).toContain('step 0');
    expect(provider.currentStep).toBe(0);

    // An explicit expectedStep hint that does not match the next recorded step.
    const hinted = catchTapeError(() => provider.step({ messages: step0Messages(), model: MODEL }, 2));
    expect(hinted.reason).toBe('out-of-order');
    expect(hinted.message).toContain('step 2');

    // A tape whose entries are not sequentially numbered.
    const raw = buildTape().toObject();
    raw.entries[1]!.step = 7;
    const broken = ReplayProvider.fromObject(raw);
    broken.step({ messages: step0Messages(), model: MODEL });
    const unordered = catchTapeError(() => broken.step({ messages: step1Messages(), model: MODEL }));
    expect(unordered.reason).toBe('out-of-order');
    expect(unordered.message).toContain('out of order');
  });

  it('flags missing and unexpected tool calls with dedicated reasons', () => {
    const missingProvider = new ReplayProvider(buildTape());
    missingProvider.step({ messages: step0Messages(), model: MODEL });
    const missingCall: Message[] = [
      { role: 'user', content: USER_PROMPT },
      { role: 'assistant', content: null, toolCalls: [calcCall('25 * 4', 'call_calc_1')] },
      toolMessage('call_weather_1', 'get_weather', WEATHER_OUTPUT),
      toolMessage('call_calc_1', 'calculator', CALC_OUTPUT_1),
    ];
    const missingError = catchTapeError(() => missingProvider.step({ messages: missingCall, model: MODEL }));
    expect(missingError.reason).toBe('missing-tool-call');
    expect(missingError.message).toContain('get_weather');

    const extraProvider = new ReplayProvider(buildTape());
    extraProvider.step({ messages: step0Messages(), model: MODEL });
    const extraCall: Message[] = [
      { role: 'user', content: USER_PROMPT },
      {
        role: 'assistant',
        content: null,
        toolCalls: [weatherCall(), calcCall('25 * 4', 'call_calc_1'), calcCall('1 + 1', 'call_extra')],
      },
      toolMessage('call_weather_1', 'get_weather', WEATHER_OUTPUT),
      toolMessage('call_calc_1', 'calculator', CALC_OUTPUT_1),
    ];
    const extraError = catchTapeError(() => extraProvider.step({ messages: extraCall, model: MODEL }));
    expect(extraError.reason).toBe('unexpected-tool-call');
  });

  it('rejects requests whose model differs from the recorded step', () => {
    const provider = new ReplayProvider(buildTape());
    const error = catchTapeError(() => provider.step({ messages: step0Messages(), model: 'gpt-4o-mini' }));
    expect(error.reason).toBe('input-mismatch');
    expect(error.message).toContain('model');
    expect(error.message).toContain('gpt-4o-mini');
  });

  it('throws a tape-exhausted error when stepping past the end of the tape', () => {
    const provider = new ReplayProvider(buildTape());
    runAgentLoop(provider);
    expect(provider.exhausted).toBe(true);

    const error = catchTapeError(() =>
      provider.step({ messages: [{ role: 'user', content: 'one more turn' }] }),
    );
    expect(error.reason).toBe('tape-exhausted');
    expect(error.step).toBe(3);
    expect(error.message).toContain('exhausted');
    expect(error.message).toContain('3 step(s)');
  });

  it('supports peek, reset, and assertExhausted for assertion suites', () => {
    const provider = new ReplayProvider(buildTape());
    expect(provider.tape.metadata.name).toBe('weather-calc-loop');
    expect(provider.peek()?.step).toBe(0);

    const early = catchTapeError(() => provider.assertExhausted());
    expect(early.reason).toBe('tape-not-exhausted');
    expect(early.message).toContain('3 unplayed step(s)');

    provider.step({ messages: step0Messages(), model: MODEL });
    expect(provider.currentStep).toBe(1);
    expect(provider.peek()?.step).toBe(1);
    expect(provider.remaining).toBe(2);

    provider.reset();
    expect(provider.currentStep).toBe(0);
    expect(provider.remaining).toBe(3);
    expect(provider.peek()?.step).toBe(0);
  });
});
