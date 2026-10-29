import { describe, it, expect } from 'vitest';
import { Tape, TapeSchema, parseTapeData, formatZodError } from '../src/index.js';

describe('Tape & Schemas', () => {
  it('creates an empty tape with default metadata', () => {
    const tape = Tape.create({
      name: 'test-tape',
      description: 'a test tape',
    });

    expect(tape.version).toBe(1);
    expect(tape.metadata.name).toBe('test-tape');
    expect(tape.metadata.description).toBe('a test tape');
    expect(tape.metadata.agentName).toBe('agent');
    expect(tape.metadata.id).toBeDefined();
    expect(tape.metadata.createdAt).toBeDefined();
    expect(tape.length).toBe(0);
    expect(tape.getEntries()).toEqual([]);
  });

  it('records valid steps and auto-assigns sequential indices', () => {
    const tape = Tape.create({ name: 'multi-turn-agent' });

    const step0 = tape.record({
      input: {
        messages: [{ role: 'user', content: 'Calculate 25 * 4' }],
      },
      output: {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call_calc_1',
              name: 'calculator',
              arguments: { expression: '25 * 4' },
            },
          ],
        },
        finishReason: 'tool_calls',
      },
      toolResults: [
        {
          callId: 'call_calc_1',
          name: 'calculator',
          output: { result: 100 },
        },
      ],
    });

    const step1 = tape.record({
      input: {
        messages: [
          { role: 'user', content: 'Calculate 25 * 4' },
          {
            role: 'assistant',
            toolCalls: [
              {
                id: 'call_calc_1',
                name: 'calculator',
                arguments: { expression: '25 * 4' },
              },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call_calc_1',
            name: 'calculator',
            content: '100',
          },
        ],
      },
      output: {
        message: {
          role: 'assistant',
          content: '25 * 4 equals 100.',
        },
        finishReason: 'stop',
      },
    });

    expect(tape.length).toBe(2);
    expect(step0.step).toBe(0);
    expect(step1.step).toBe(1);
    expect(tape.getEntry(0)?.output.finishReason).toBe('tool_calls');
    expect(tape.getEntry(1)?.output.message.content).toBe('25 * 4 equals 100.');
  });

  it('serializes to JSON and round-trips cleanly', () => {
    const tape = Tape.create({
      name: 'round-trip',
      agentName: 'MathBot',
      tags: ['math', 'unit-test'],
    });

    tape.record({
      input: {
        messages: [{ role: 'user', content: 'Ping' }],
        model: 'gpt-4o',
      },
      output: {
        message: { role: 'assistant', content: 'Pong' },
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      },
    });

    const json = tape.toJSON();
    expect(typeof json).toBe('string');

    const restored = Tape.fromJSON(json);
    expect(restored.version).toBe(1);
    expect(restored.metadata.name).toBe('round-trip');
    expect(restored.metadata.agentName).toBe('MathBot');
    expect(restored.metadata.tags).toEqual(['math', 'unit-test']);
    expect(restored.length).toBe(1);

    const entry = restored.getEntry(0);
    expect(entry).toBeDefined();
    expect(entry?.input.model).toBe('gpt-4o');
    expect(entry?.output.message.content).toBe('Pong');
    expect(entry?.output.usage?.totalTokens).toBe(7);
  });

  it('throws helpful error on malformed JSON string', () => {
    expect(() => Tape.fromJSON('{ invalid json: true')).toThrowError(
      /Failed to parse JSON for Tape/,
    );
  });

  it('validates schema and rejects missing or malformed fields', () => {
    expect(() =>
      Tape.fromObject({
        version: 1,
        metadata: { id: 'test' }, // missing 'name'
        entries: [],
      }),
    ).toThrowError(/Invalid tape data/);

    expect(() =>
      Tape.fromObject({
        version: 99, // unsupported version
        metadata: { id: 'test', name: 'tape' },
        entries: [],
      }),
    ).toThrowError(/Invalid tape data/);
  });

  it('rejects recording malformed entries', () => {
    const tape = Tape.create({ name: 'strict-tape' });

    expect(() =>
      tape.record({
        // @ts-expect-error test malformed input
        input: { messages: [{ role: 'invalid_role' }] },
        output: { message: { role: 'assistant' } },
      }),
    ).toThrowError(/Invalid tape entry/);

    expect(() =>
      tape.record({
        input: { messages: [] },
        output: {
          message: {
            role: 'assistant',
            toolCalls: [
              // @ts-expect-error missing name
              { id: '123' },
            ],
          },
        },
      }),
    ).toThrowError(/Invalid tape entry/);
  });

  it('filters entries into a re-indexed tape', () => {
    const tape = Tape.create({ name: 'filter-test' });
    tape.record({
      input: { messages: [{ role: 'user', content: 'first' }] },
      output: { message: { role: 'assistant', content: 'res1' } },
      metadata: { keep: false },
    });
    tape.record({
      input: { messages: [{ role: 'user', content: 'second' }] },
      output: { message: { role: 'assistant', content: 'res2' } },
      metadata: { keep: true },
    });

    const filtered = tape.filter((e) => Boolean(e.metadata?.keep));
    expect(filtered.length).toBe(1);
    expect(filtered.getEntry(0)?.step).toBe(0);
    expect(filtered.getEntry(0)?.output.message.content).toBe('res2');
  });

  it('clones a tape independently', () => {
    const original = Tape.create({ name: 'original' });
    original.record({
      input: { messages: [{ role: 'user', content: 'hi' }] },
      output: { message: { role: 'assistant', content: 'hello' } },
    });

    const clone = original.clone();
    expect(clone.length).toBe(1);
    expect(clone.metadata.name).toBe('original');

    clone.record({
      input: { messages: [{ role: 'user', content: 'more' }] },
      output: { message: { role: 'assistant', content: 'more reply' } },
    });

    expect(original.length).toBe(1);
    expect(clone.length).toBe(2);
  });

  it('formatZodError produces human-readable paths', () => {
    const res = TapeSchema.safeParse({
      version: 1,
      metadata: { id: 'x', name: '' },
      entries: 'invalid-entries',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const formatted = formatZodError(res.error);
      expect(formatted).toContain('metadata.name');
      expect(formatted).toContain('entries');
    }
  });

  it('parses valid raw object with parseTapeData', () => {
    const raw = {
      version: 1,
      metadata: {
        id: 'tape-1',
        name: 'test',
      },
      entries: [],
    };
    const parsed = parseTapeData(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.metadata.name).toBe('test');
  });
});
