import { Tape } from './tape.js';
import type {
  FinishReason,
  Message,
  StepInput,
  TapeEntry,
  ToolCall,
  ToolResult,
  Usage,
} from './schema.js';

/**
 * Matching strategy applied to tool call arguments while replaying a tape.
 *
 * - `'exact'`: recorded and incoming arguments must be deep-equal.
 * - `'fuzzy'`: incoming arguments may be a superset of the recorded ones
 *   (extra keys are allowed at any nesting depth); every recorded key must
 *   still match.
 */
export type ArgumentMatchMode = 'exact' | 'fuzzy';

/**
 * Machine-readable reason attached to a {@link TapeMismatchError}.
 */
export type TapeMismatchReason =
  | 'tape-exhausted'
  | 'tape-not-exhausted'
  | 'out-of-order'
  | 'input-mismatch'
  | 'missing-tool-call'
  | 'unexpected-tool-call'
  | 'argument-mismatch';

/**
 * A single field-level deviation detected while matching an incoming step
 * against the next recorded tape entry.
 */
export interface FieldMismatch {
  /** Path of the offending field, e.g. `messages[1].toolCalls[0].arguments`. */
  readonly path: string;
  /** Classification of the deviation. */
  readonly kind: TapeMismatchReason;
  /** Value recorded on the tape. */
  readonly expected: unknown;
  /** Value received from the agent under test. */
  readonly actual: unknown;
  /** Human-readable description of the deviation. */
  readonly message: string;
}

/** Options accepted by the {@link TapeMismatchError} constructor. */
export interface TapeMismatchErrorOptions {
  readonly reason: TapeMismatchReason;
  readonly step: number;
  readonly summary: string;
  readonly tapeName?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly mismatches?: readonly FieldMismatch[];
}

/**
 * Error thrown by {@link ReplayProvider.step} when the incoming agent action
 * deviates from the recorded tape. Carries a formatted expected-vs-actual
 * diff plus structured field mismatches for programmatic assertions.
 */
export class TapeMismatchError extends Error {
  readonly reason: TapeMismatchReason;
  readonly step: number;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly mismatches: readonly FieldMismatch[];
  readonly diff: string;

  constructor(options: TapeMismatchErrorOptions) {
    const hasDiff = options.expected !== undefined || options.actual !== undefined;
    const diff = hasDiff ? formatDiff(options.expected, options.actual) : '';
    const lines: string[] = [
      `Tape mismatch at step ${options.step} (${options.reason})` +
        (options.tapeName ? ` in tape "${options.tapeName}"` : '') +
        ':',
      options.summary,
    ];
    if (options.mismatches !== undefined && options.mismatches.length > 0) {
      lines.push('Field mismatches:');
      for (const mismatch of options.mismatches) {
        lines.push(`  - ${mismatch.path}: ${mismatch.message}`);
      }
    }
    if (diff.length > 0) {
      lines.push('Expected vs actual diff (- expected, + actual):');
      lines.push(diff);
    }
    super(lines.join('\n'));
    this.name = 'TapeMismatchError';
    this.reason = options.reason;
    this.step = options.step;
    this.expected = options.expected;
    this.actual = options.actual;
    this.mismatches = options.mismatches ?? [];
    this.diff = diff;
  }
}

/** Options for constructing a {@link ReplayProvider}. */
export interface ReplayOptions {
  /** Matching strategy for tool call arguments. Defaults to `'exact'`. */
  readonly matchMode?: ArgumentMatchMode;
}

/** Request accepted by {@link ReplayProvider.step}. */
export type ReplayStepRequest = StepInput | readonly Message[];

/** Result returned by {@link ReplayProvider.step} for a matching step. */
export interface ReplayStepResult {
  /** Recorded step index that was consumed. */
  readonly step: number;
  /** The full recorded tape entry that was replayed. */
  readonly entry: Readonly<TapeEntry>;
  /** Recorded assistant message (may contain tool calls). */
  readonly message: Message;
  /** Recorded finish reason. */
  readonly finishReason: FinishReason;
  /** Recorded tool results to feed back into the agent loop. */
  readonly toolResults: readonly ToolResult[];
  /** Recorded token usage, if any. */
  readonly usage: Usage | undefined;
}

/**
 * Offline playback provider that replays a recorded {@link Tape} step by step.
 *
 * Each call to {@link ReplayProvider.step} validates the incoming request
 * against the next recorded entry (message sequence, tool calls, and tool
 * call arguments under the configured match mode) and returns the recorded
 * assistant message and tool results. Any deviation throws a
 * {@link TapeMismatchError} with a formatted expected-vs-actual diff.
 */
export class ReplayProvider {
  private readonly _tape: Tape;
  private readonly _entries: readonly TapeEntry[];
  private readonly _mode: ArgumentMatchMode;
  private _cursor = 0;

  /**
   * Create a replay provider for a tape.
   *
   * @param tape The recorded tape to play back.
   * @param options Matching options; `matchMode` defaults to `'exact'`.
   */
  constructor(tape: Tape, options: ReplayOptions = {}) {
    this._tape = tape;
    this._entries = tape.getEntries();
    this._mode = options.matchMode ?? 'exact';
  }

  /**
   * Build a provider from a serialized JSON tape fixture.
   */
  public static fromJSON(json: string, options: ReplayOptions = {}): ReplayProvider {
    return new ReplayProvider(Tape.fromJSON(json), options);
  }

  /**
   * Build a provider from a raw (unvalidated) tape object.
   */
  public static fromObject(raw: unknown, options: ReplayOptions = {}): ReplayProvider {
    return new ReplayProvider(Tape.fromObject(raw), options);
  }

  /** The tape being replayed. */
  public get tape(): Tape {
    return this._tape;
  }

  /** The argument matching strategy in use. */
  public get matchMode(): ArgumentMatchMode {
    return this._mode;
  }

  /** Index of the next step to be replayed. */
  public get currentStep(): number {
    return this._cursor;
  }

  /** Total number of recorded steps. */
  public get length(): number {
    return this._entries.length;
  }

  /** Number of steps still waiting to be replayed. */
  public get remaining(): number {
    return this._entries.length - this._cursor;
  }

  /** Whether every recorded step has been replayed. */
  public get exhausted(): boolean {
    return this._cursor >= this._entries.length;
  }

  /**
   * Peek at the next recorded entry without consuming it.
   */
  public peek(): TapeEntry | undefined {
    return this._entries[this._cursor];
  }

  /**
   * Rewind the provider to the first step.
   */
  public reset(): void {
    this._cursor = 0;
  }

  /**
   * Validate and replay the next recorded step.
   *
   * @param request The incoming step request: either a full {@link StepInput}
   *   or a bare message array. The message sequence must match the recorded
   *   entry's input; tool call arguments are compared under the configured
   *   match mode.
   * @param expectedStep Optional step index the caller expects to replay;
   *   a mismatch is reported as an `out-of-order` error.
   * @returns The recorded assistant message, tool results, and step metadata.
   * @throws {TapeMismatchError} When the tape is exhausted, the step order is
   *   wrong, or the incoming messages/tool calls deviate from the recording.
   */
  public step(request: ReplayStepRequest, expectedStep?: number): ReplayStepResult {
    const tapeName = this._tape.metadata.name;
    const entry = this._entries[this._cursor];
    if (entry === undefined) {
      throw new TapeMismatchError({
        reason: 'tape-exhausted',
        step: this._cursor,
        tapeName,
        summary:
          `Tape "${tapeName}" is exhausted after ${this._entries.length} step(s); ` +
          'received an unexpected additional step.',
        expected: `${this._entries.length} step(s) recorded`,
        actual: `step ${this._cursor} requested`,
      });
    }
    if (entry.step !== this._cursor) {
      throw new TapeMismatchError({
        reason: 'out-of-order',
        step: this._cursor,
        tapeName,
        summary:
          `Tape entries are out of order: expected step ${this._cursor} ` +
          `but the next recorded entry has step ${entry.step}.`,
        expected: this._cursor,
        actual: entry.step,
      });
    }
    if (expectedStep !== undefined && expectedStep !== entry.step) {
      throw new TapeMismatchError({
        reason: 'out-of-order',
        step: entry.step,
        tapeName,
        summary:
          `Step order mismatch: caller expected step ${expectedStep} ` +
          `but the next recorded step is ${entry.step}.`,
        expected: expectedStep,
        actual: entry.step,
      });
    }

    const actualInput = normalizeRequest(request);
    const mismatches = compareStepInput(entry.input, actualInput, this._mode);
    if (mismatches.length > 0) {
      const first = mismatches[0]!;
      throw new TapeMismatchError({
        reason: first.kind,
        step: entry.step,
        tapeName,
        summary: `Incoming step does not match recorded step ${entry.step}: ${first.message}`,
        expected: entry.input,
        actual: actualInput,
        mismatches,
      });
    }

    this._cursor += 1;
    return {
      step: entry.step,
      entry,
      message: entry.output.message,
      finishReason: entry.output.finishReason,
      toolResults: entry.toolResults,
      usage: entry.output.usage,
    };
  }

  /**
   * Assert that every recorded step has been replayed.
   *
   * @throws {TapeMismatchError} With reason `'tape-not-exhausted'` when steps remain.
   */
  public assertExhausted(): void {
    if (!this.exhausted) {
      throw new TapeMismatchError({
        reason: 'tape-not-exhausted',
        step: this._cursor,
        tapeName: this._tape.metadata.name,
        summary:
          `Tape "${this._tape.metadata.name}" still has ${this.remaining} unplayed step(s) ` +
          `starting at step ${this._cursor}; the agent loop ended before the tape was fully replayed.`,
        expected: this.remaining,
        actual: 0,
      });
    }
  }
}

function normalizeRequest(request: ReplayStepRequest): StepInput {
  if (isMessageArray(request)) {
    return { messages: [...request] };
  }
  return request;
}

function isMessageArray(request: ReplayStepRequest): request is readonly Message[] {
  return Array.isArray(request);
}

function compareStepInput(
  expected: StepInput,
  actual: StepInput,
  mode: ArgumentMatchMode,
): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  compareMessages(expected.messages, actual.messages, mode, out);
  compareRecordedScalar('model', expected.model, actual.model, out);
  compareRecordedScalar('temperature', expected.temperature, actual.temperature, out);
  compareRecordedScalar('maxTokens', expected.maxTokens, actual.maxTokens, out);
  return out;
}

function compareRecordedScalar(
  path: string,
  expected: unknown,
  actual: unknown,
  out: FieldMismatch[],
): void {
  if (expected !== undefined && !deepEqual(expected, actual)) {
    out.push({
      path,
      kind: 'input-mismatch',
      expected,
      actual,
      message: `${path} mismatch: expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`,
    });
  }
}

function compareMessages(
  expected: readonly Message[],
  actual: readonly Message[],
  mode: ArgumentMatchMode,
  out: FieldMismatch[],
): void {
  if (expected.length !== actual.length) {
    out.push({
      path: 'messages',
      kind: 'input-mismatch',
      expected: expected.length,
      actual: actual.length,
      message: `message count mismatch: expected ${expected.length} message(s) but received ${actual.length}`,
    });
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    compareMessage(expected[i]!, actual[i]!, `messages[${i}]`, mode, out);
  }
}

function compareMessage(
  expected: Message,
  actual: Message,
  path: string,
  mode: ArgumentMatchMode,
  out: FieldMismatch[],
): void {
  if (expected.role !== actual.role) {
    out.push({
      path: `${path}.role`,
      kind: 'input-mismatch',
      expected: expected.role,
      actual: actual.role,
      message: `role mismatch: expected "${expected.role}" but received "${actual.role}"`,
    });
  }
  const expectedContent = expected.content ?? null;
  const actualContent = actual.content ?? null;
  if (!deepEqual(expectedContent, actualContent)) {
    out.push({
      path: `${path}.content`,
      kind: 'input-mismatch',
      expected: expectedContent,
      actual: actualContent,
      message: `content mismatch: expected ${JSON.stringify(expectedContent)} but received ${JSON.stringify(actualContent)}`,
    });
  }
  if (!deepEqual(expected.name, actual.name)) {
    out.push({
      path: `${path}.name`,
      kind: 'input-mismatch',
      expected: expected.name,
      actual: actual.name,
      message: `name mismatch: expected ${JSON.stringify(expected.name)} but received ${JSON.stringify(actual.name)}`,
    });
  }
  if (!deepEqual(expected.toolCallId, actual.toolCallId)) {
    out.push({
      path: `${path}.toolCallId`,
      kind: 'input-mismatch',
      expected: expected.toolCallId,
      actual: actual.toolCallId,
      message: `toolCallId mismatch: expected ${JSON.stringify(expected.toolCallId)} but received ${JSON.stringify(actual.toolCallId)}`,
    });
  }
  compareToolCalls(expected.toolCalls, actual.toolCalls, `${path}.toolCalls`, mode, out);
}

function compareToolCalls(
  expected: readonly ToolCall[] | undefined,
  actual: readonly ToolCall[] | undefined,
  path: string,
  mode: ArgumentMatchMode,
  out: FieldMismatch[],
): void {
  if (expected === undefined && actual === undefined) {
    return;
  }
  if (expected === undefined) {
    out.push({
      path,
      kind: 'unexpected-tool-call',
      expected: undefined,
      actual,
      message: `unexpected tool call(s): none were recorded but ${actual?.length ?? 0} were received`,
    });
    return;
  }
  if (actual === undefined) {
    out.push({
      path,
      kind: 'missing-tool-call',
      expected,
      actual: undefined,
      message: `missing tool call(s): expected ${expected.length} but received none`,
    });
    return;
  }
  if (expected.length !== actual.length) {
    const kind: TapeMismatchReason =
      actual.length < expected.length ? 'missing-tool-call' : 'unexpected-tool-call';
    const expectedNames = expected.map((call) => call.name).join(', ');
    const actualNames = actual.map((call) => call.name).join(', ');
    out.push({
      path,
      kind,
      expected: expectedNames,
      actual: actualNames,
      message: `${kind === 'missing-tool-call' ? 'missing' : 'unexpected'} tool call(s): expected [${expectedNames}] but received [${actualNames}]`,
    });
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const expectedCall = expected[i]!;
    const actualCall = actual[i]!;
    const callPath = `${path}[${i}]`;
    if (expectedCall.id !== actualCall.id) {
      out.push({
        path: `${callPath}.id`,
        kind: 'input-mismatch',
        expected: expectedCall.id,
        actual: actualCall.id,
        message: `tool call id mismatch: expected "${expectedCall.id}" but received "${actualCall.id}"`,
      });
    }
    if (expectedCall.name !== actualCall.name) {
      out.push({
        path: `${callPath}.name`,
        kind: 'input-mismatch',
        expected: expectedCall.name,
        actual: actualCall.name,
        message: `tool call name mismatch: expected "${expectedCall.name}" but received "${actualCall.name}"`,
      });
    }
    const argumentsMatch =
      mode === 'fuzzy'
        ? fuzzySubset(expectedCall.arguments, actualCall.arguments)
        : deepEqual(expectedCall.arguments, actualCall.arguments);
    if (!argumentsMatch) {
      out.push({
        path: `${callPath}.arguments`,
        kind: 'argument-mismatch',
        expected: expectedCall.arguments,
        actual: actualCall.arguments,
        message:
          `tool call "${expectedCall.name}" (${expectedCall.id}) arguments do not match in ${mode} mode: ` +
          `expected ${JSON.stringify(expectedCall.arguments)} but received ${JSON.stringify(actualCall.arguments)}`,
      });
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function fuzzySubset(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    for (const key of Object.keys(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, key)) {
        return false;
      }
      if (!fuzzySubset(expected[key], actual[key])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    for (let i = 0; i < expected.length; i++) {
      if (!fuzzySubset(expected[i], actual[i])) {
        return false;
      }
    }
    return true;
  }
  return deepEqual(expected, actual);
}

/**
 * Render a line-based expected-vs-actual diff for two JSON-ish values.
 * Lines only present in `expected` are prefixed with `-`, lines only present
 * in `actual` with `+`, and common lines with two spaces.
 */
export function formatDiff(expected: unknown, actual: unknown): string {
  const expectedLines = toLines(expected);
  const actualLines = toLines(actual);
  const rows = expectedLines.length;
  const cols = actualLines.length;

  // dp[i][j] = length of the longest common subsequence of expectedLines[i..] and actualLines[j..].
  const dp: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    dp.push(new Array<number>(cols + 1).fill(0));
  }
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i]![j] =
        expectedLines[i] === actualLines[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (expectedLines[i] === actualLines[j]) {
      out.push(`  ${expectedLines[i]!}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${expectedLines[i]!}`);
      i += 1;
    } else {
      out.push(`+ ${actualLines[j]!}`);
      j += 1;
    }
  }
  while (i < rows) {
    out.push(`- ${expectedLines[i]!}`);
    i += 1;
  }
  while (j < cols) {
    out.push(`+ ${actualLines[j]!}`);
    j += 1;
  }
  return out.join('\n');
}

function toLines(value: unknown): string[] {
  if (value === undefined) {
    return ['undefined'];
  }
  const json = JSON.stringify(value, null, 2);
  return (json ?? String(value)).split('\n');
}
