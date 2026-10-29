import { ReplayProvider } from './replay.js';
import type {
  ArgumentMatchMode,
  ReplayStepRequest,
  ReplayStepResult,
} from './replay.js';
import { Tape } from './tape.js';
import type { TapeEntry } from './schema.js';

/**
 * Options accepted when constructing a {@link TapeAssertion}.
 */
export interface TapeAssertionOptions {
  /**
   * Argument matching strategy forwarded to the underlying replay provider.
   *
   * Defaults to `'fuzzy'`: every recorded tool-argument key must match, but
   * the agent under test may pass additional keys at any nesting depth.
   * Use `'exact'` for strict deep-equality on tool call arguments.
   */
  readonly matchMode?: ArgumentMatchMode;
}

/**
 * Per-step options accepted by {@link TapeAssertion.step}.
 */
export interface AssertionStepOptions {
  /**
   * Step index the caller expects to replay next. When provided and different
   * from the next recorded step, an `out-of-order` mismatch is thrown before
   * anything is consumed.
   */
  readonly expectedStep?: number;
}

/**
 * High-level assertion helper for agent loops.
 *
 * Composes a recorded {@link Tape} with a {@link ReplayProvider} so tests can
 * assert a multi-turn tool-calling session step by step, fully offline:
 *
 * ```ts
 * const assertion = new TapeAssertion(tape); // fuzzy matching by default
 * const step0 = assertion.step({ messages, model: 'gpt-4o' }, { expectedStep: 0 });
 * // ... feed step0.toolResults back into the agent under test ...
 * assertion.assertExhausted();
 * ```
 *
 * Any deviation from the recording (wrong step order, missing or unexpected
 * tool calls, mismatched tool arguments) throws a `TapeMismatchError`
 * carrying field-level mismatches and a formatted expected-vs-actual diff.
 */
export class TapeAssertion {
  private readonly _provider: ReplayProvider;

  /**
   * Wrap a recorded tape for step-by-step assertions.
   *
   * @param tape The recorded tape to assert against.
   * @param options Assertion options; `matchMode` defaults to `'fuzzy'`.
   */
  constructor(tape: Tape, options: TapeAssertionOptions = {}) {
    this._provider = new ReplayProvider(tape, { matchMode: options.matchMode ?? 'fuzzy' });
  }

  /**
   * Build an assertion from a serialized JSON tape fixture.
   */
  public static fromJSON(json: string, options: TapeAssertionOptions = {}): TapeAssertion {
    return new TapeAssertion(Tape.fromJSON(json), options);
  }

  /**
   * Build an assertion from a raw (unvalidated) tape object.
   */
  public static fromObject(raw: unknown, options: TapeAssertionOptions = {}): TapeAssertion {
    return new TapeAssertion(Tape.fromObject(raw), options);
  }

  /** The tape under assertion. */
  public get tape(): Tape {
    return this._provider.tape;
  }

  /** The underlying replay provider. */
  public get provider(): ReplayProvider {
    return this._provider;
  }

  /** The argument matching strategy in use (`'fuzzy'` unless overridden). */
  public get matchMode(): ArgumentMatchMode {
    return this._provider.matchMode;
  }

  /** Index of the next step to be replayed. */
  public get currentStep(): number {
    return this._provider.currentStep;
  }

  /** Total number of recorded steps. */
  public get length(): number {
    return this._provider.length;
  }

  /** Number of steps still waiting to be replayed. */
  public get remaining(): number {
    return this._provider.remaining;
  }

  /** Whether every recorded step has been replayed. */
  public get exhausted(): boolean {
    return this._provider.exhausted;
  }

  /**
   * Assert and replay the next recorded step.
   *
   * @param input The incoming step request: a full step input or a bare
   *   message array produced by the agent under test.
   * @param options Per-step options, e.g. an `expectedStep` order hint.
   * @returns The recorded assistant message, tool results, and step metadata.
   * @throws {TapeMismatchError} When the incoming step deviates from the tape.
   */
  public step(input: ReplayStepRequest, options: AssertionStepOptions = {}): ReplayStepResult {
    return this._provider.step(input, options.expectedStep);
  }

  /**
   * Peek at the next recorded entry without consuming it.
   */
  public peek(): TapeEntry | undefined {
    return this._provider.peek();
  }

  /**
   * Rewind the assertion to the first recorded step.
   */
  public reset(): void {
    this._provider.reset();
  }

  /**
   * Assert that every recorded step has been replayed.
   *
   * @throws {TapeMismatchError} With reason `'tape-not-exhausted'` when steps remain.
   */
  public assertExhausted(): void {
    this._provider.assertExhausted();
  }
}

/**
 * Create a {@link TapeAssertion} from a {@link Tape} instance or a serialized
 * JSON tape fixture string.
 *
 * @param tape A recorded tape, or its JSON serialization.
 * @param options Assertion options; `matchMode` defaults to `'fuzzy'`.
 */
export function createAssertion(
  tape: Tape | string,
  options: TapeAssertionOptions = {},
): TapeAssertion {
  return typeof tape === 'string'
    ? TapeAssertion.fromJSON(tape, options)
    : new TapeAssertion(tape, options);
}
