import { Effect, Schema, SchemaGetter } from "effect";
import type { MachineContext, MachineDefinition, MachineEvent, MachineSnapshot } from "./types.js";

// ============================================================================
// Encoded Snapshot Type
// ============================================================================

/**
 * The JSON-safe encoded format of a snapshot.
 */
export interface EncodedSnapshot<TStateValue extends string, TContextEncoded> {
  readonly value: TStateValue;
  readonly context: TContextEncoded;
}

// ============================================================================
// Encoding/Decoding Utilities
// ============================================================================

/**
 * Encode a snapshot to a JSON-safe format.
 *
 * @example
 * ```ts
 * const encoded = yield* encodeSnapshot(machine, actor.getSnapshot());
 * localStorage.setItem("state", JSON.stringify(encoded));
 * ```
 */
export const encodeSnapshot = <
  TStateValue extends string,
  TContext extends MachineContext,
  TContextEncoded,
  TSchemaR,
>(
  machine: MachineDefinition<string, TStateValue, TContext, MachineEvent, unknown, unknown, TContextEncoded, TSchemaR>,
  snapshot: MachineSnapshot<TStateValue, TContext>,
): Effect.Effect<EncodedSnapshot<TStateValue, TContextEncoded>, Schema.SchemaError, TSchemaR> =>
  Effect.map(
    Schema.encodeEffect(machine.contextSchema)(snapshot.context),
    (context) => ({
      value: snapshot.value,
      context,
    }),
  );

/**
 * Encode a snapshot to a JSON-safe format (sync, throws on error).
 */
export const encodeSnapshotSync = <
  TStateValue extends string,
  TContext extends MachineContext,
  TContextEncoded,
>(
  machine: MachineDefinition<string, TStateValue, TContext, MachineEvent, unknown, unknown, TContextEncoded>,
  snapshot: MachineSnapshot<TStateValue, TContext>,
): EncodedSnapshot<TStateValue, TContextEncoded> => ({
  value: snapshot.value,
  context: Schema.encodeSync(machine.contextSchema)(snapshot.context),
});

/**
 * Decode a snapshot from a JSON-safe format.
 *
 * @example
 * ```ts
 * const stored = JSON.parse(localStorage.getItem("state")!);
 * const snapshot = yield* decodeSnapshot(machine, stored);
 * const actor = yield* interpret(machine, { snapshot });
 * ```
 */
export const decodeSnapshot = <
  TStateValue extends string,
  TContext extends MachineContext,
  TContextEncoded,
  TSchemaR,
>(
  machine: MachineDefinition<string, TStateValue, TContext, MachineEvent, unknown, unknown, TContextEncoded, TSchemaR>,
  encoded: EncodedSnapshot<TStateValue, TContextEncoded>,
): Effect.Effect<MachineSnapshot<TStateValue, TContext>, Schema.SchemaError, TSchemaR> =>
  Effect.map(
    Schema.decodeEffect(machine.contextSchema)(encoded.context),
    (context) => ({
      value: encoded.value,
      context,
      event: null,
    }),
  );

/**
 * Decode a snapshot from a JSON-safe format (sync, throws on error).
 */
export const decodeSnapshotSync = <
  TStateValue extends string,
  TContext extends MachineContext,
  TContextEncoded,
>(
  machine: MachineDefinition<string, TStateValue, TContext, MachineEvent, unknown, unknown, TContextEncoded>,
  encoded: EncodedSnapshot<TStateValue, TContextEncoded>,
): MachineSnapshot<TStateValue, TContext> => ({
  value: encoded.value,
  context: Schema.decodeSync(machine.contextSchema)(encoded.context),
  event: null,
});

// ============================================================================
// Snapshot Schema Builder (for advanced use)
// ============================================================================

/**
 * Get the context schema from a machine definition.
 */
export const getContextSchema = <
  TContext extends MachineContext,
  TContextEncoded,
  TSchemaR,
>(
  machine: MachineDefinition<string, string, TContext, MachineEvent, unknown, unknown, TContextEncoded, TSchemaR>,
): Schema.Codec<TContext, TContextEncoded, TSchemaR, TSchemaR> => machine.contextSchema;

/**
 * Create a Schema for the encoded snapshot format.
 * Useful for validation when loading from external sources.
 *
 * @example
 * ```ts
 * const schema = createSnapshotSchema(machine);
 * const validated = Schema.decodeUnknownSync(schema)(untrustedData);
 * ```
 */
export const createSnapshotSchema = <
  TStateValue extends string,
  TContext extends MachineContext,
  TContextEncoded,
>(
  machine: MachineDefinition<string, TStateValue, TContext, MachineEvent, unknown, unknown, TContextEncoded>,
) => {
  const contextSchema = machine.contextSchema;
  const encodedContextSchema = Schema.toEncoded(contextSchema);

  const fromSchema = Schema.Struct({
    value: Schema.String,
    context: encodedContextSchema,
  });
  const toSchema = Schema.Struct({
    value: Schema.String,
    context: contextSchema,
    event: Schema.NullOr(Schema.Unknown),
  });

  // The resulting schema's `Type` is `{ value: string; context: TContext;
  // event: unknown | null }` rather than the nominal `MachineSnapshot<
  // TStateValue, TContext>` (`value: TStateValue`, `event: MachineEvent |
  // null`): Struct field schemas can't reference a generic literal/union
  // type parameter at the value level. `event` is intentionally excluded
  // from (de)serialization (decode always sets it to `null`). Any actual
  // `MachineSnapshot<TStateValue, TContext>` is structurally assignable to
  // this wider `Type` (TStateValue extends string; MachineEvent | null is
  // assignable to unknown | null), so `Schema.encodeSync`/`decodeSync`
  // remain usable with real snapshot values without any cast.
  return fromSchema.pipe(
    Schema.decodeTo(toSchema, {
      decode: SchemaGetter.transform((encoded) => ({ ...encoded, event: null })),
      encode: SchemaGetter.transform((snapshot) => ({ value: snapshot.value, context: snapshot.context })),
    }),
  );
};
