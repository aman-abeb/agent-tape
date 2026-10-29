import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  TapeSchema,
  TapeEntrySchema,
  type TapeData,
  type TapeEntry,
  type TapeMetadata,
  parseTapeData,
  formatZodError,
} from './schema.js';

export interface CreateTapeOptions {
  id?: string;
  name: string;
  description?: string;
  agentName?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
  createdAt?: string;
}

export type TapeEntryInput = Omit<z.input<typeof TapeEntrySchema>, 'id' | 'step'> & {
  id?: string;
  step?: number;
};

/**
 * Tape represents a recorded session of an agent interaction loop.
 * Encapsulates steps, tool calls, and LLM completions with deterministic replay serialization.
 */
export class Tape {
  public readonly version = 1 as const;
  private _metadata: TapeMetadata;
  private _entries: TapeEntry[];

  constructor(metadata: TapeMetadata, entries: TapeEntry[] = []) {
    this._metadata = { ...metadata };
    this._entries = [...entries];
  }

  /**
   * Create a new empty tape with metadata defaults.
   */
  public static create(options: CreateTapeOptions): Tape {
    const metadata: TapeMetadata = {
      id: options.id ?? randomUUID(),
      name: options.name,
      description: options.description ?? '',
      agentName: options.agentName ?? 'agent',
      createdAt: options.createdAt ?? new Date().toISOString(),
      tags: options.tags ?? [],
      custom: options.custom ?? {},
    };
    return new Tape(metadata, []);
  }

  /**
   * Parse and instantiate a Tape instance from an arbitrary object.
   */
  public static fromObject(raw: unknown): Tape {
    const parsed = parseTapeData(raw);
    return new Tape(parsed.metadata, parsed.entries);
  }

  /**
   * Parse and instantiate a Tape instance from a JSON string.
   */
  public static fromJSON(jsonString: string): Tape {
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(jsonString);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse JSON for Tape: ${message}`);
    }
    return Tape.fromObject(parsedRaw);
  }

  /**
   * Metadata of the tape.
   */
  public get metadata(): Readonly<TapeMetadata> {
    return { ...this._metadata };
  }

  /**
   * Number of recorded interaction steps in the tape.
   */
  public get length(): number {
    return this._entries.length;
  }

  /**
   * Returns an immutable shallow copy of all recorded entries.
   */
  public getEntries(): readonly TapeEntry[] {
    return [...this._entries];
  }

  /**
   * Retrieve a specific step by its index (0-based).
   */
  public getEntry(step: number): TapeEntry | undefined {
    return this._entries.find((entry) => entry.step === step);
  }

  /**
   * Append an interaction entry to this tape.
   * Automatically assigns an ID and incremental step index if omitted.
   */
  public record(entry: TapeEntryInput): TapeEntry {
    const candidate = {
      id: entry.id ?? randomUUID(),
      step: entry.step ?? this._entries.length,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      input: entry.input,
      output: entry.output,
      toolResults: entry.toolResults ?? [],
      metadata: entry.metadata ?? {},
    };

    const validation = TapeEntrySchema.safeParse(candidate);
    if (!validation.success) {
      throw new Error(`Invalid tape entry: ${formatZodError(validation.error)}`);
    }

    const validEntry = validation.data;
    this._entries.push(validEntry);
    return validEntry;
  }

  /**
   * Filter entries according to a predicate and return a new Tape instance.
   */
  public filter(predicate: (entry: TapeEntry, index: number) => boolean): Tape {
    const filtered = this._entries.filter(predicate).map((entry, index) => ({
      ...entry,
      step: index,
    }));
    return new Tape({ ...this._metadata }, filtered);
  }

  /**
   * Clone the current tape.
   */
  public clone(): Tape {
    return new Tape({ ...this._metadata }, JSON.parse(JSON.stringify(this._entries)));
  }

  /**
   * Export the tape as a validated plain object schema.
   */
  public toObject(): TapeData {
    const data: TapeData = {
      version: 1,
      metadata: { ...this._metadata },
      entries: JSON.parse(JSON.stringify(this._entries)),
    };
    // Re-verify against schema before returning to guarantee conformance
    return TapeSchema.parse(data);
  }

  /**
   * Serialize tape to formatted JSON.
   */
  public toJSON(pretty = true): string {
    return JSON.stringify(this.toObject(), null, pretty ? 2 : undefined);
  }
}
