<h1 align="center">ArchState</h1>

<p align="center">
  <strong>Lean, schema-first state machines for Effect v4</strong>
</p>

---

**ArchState** is a state machine library built on [Effect](https://effect.website). States and events are plain Effect Schema / `Data.TaggedClass` values, context is validated by an Effect Schema, and entry/exit/long-running work is expressed as ordinary Effects and Streams — with the requirements (`R`) and error (`E`) channels intact. **Only Effect v4 is supported.**

## Features

- **Config-based machines**: `createMachine({ states: { ... } })`, in the spirit of XState's state-node shape
- **Schema-validated context**: context is an Effect Schema `Struct`, so it decodes/encodes and serializes for free
- **Type-safe**: full inference over state values, tagged events, and context
- **Effect-native**: `activities`, `invoke`, and action effects carry the full Effect `R`/`E` channels
- **Actor model**: `spawnChild`, `sendTo`, `sendParent`, `forwardTo` for parent/child machine communication
- **Guards & actions**: `assign`, `guard`/`and`/`or`/`not`, `enqueueActions`, `raise`, `emit`, and more
- **React-ready**: a typed hook factory (`createUseMachineHook`) built on Effect v4's `effect/unstable/reactivity`

## Packages

| Package | Description |
|---------|-------------|
| [`@archstate/core`](./packages/core) | The state machine engine |
| [`@archstate/react`](./packages/react) | React hook factory for `@archstate/core` machines |

## Requirements

- `effect` `^4.0.0-rc.110` (Effect v4 RC — this is the only line ArchState supports)
- Node.js + pnpm for development

## Quick Start

```bash
npm install @archstate/core effect
```

```typescript
import { Data, Effect, Schema } from "effect";
import { createMachine, interpret, assign } from "@archstate/core";

// Events are Effect's tagged data classes.
class Toggle extends Data.TaggedClass("Toggle")<{}> {}

// Context is validated by an Effect Schema.
const ContextSchema = Schema.Struct({ count: Schema.Number });

const machine = createMachine({
  id: "light",
  initial: "off",
  context: ContextSchema,
  initialContext: { count: 0 },
  states: {
    off: {
      on: {
        Toggle: {
          target: "on",
          actions: [assign(({ context }) => ({ count: context.count + 1 }))],
        },
      },
    },
    on: {
      on: { Toggle: { target: "off" } },
    },
  },
});

const program = Effect.gen(function* () {
  const actor = yield* interpret(machine);

  actor.subscribe((snapshot) => {
    console.log(snapshot.value, snapshot.context.count);
  });

  actor.send(new Toggle());
});

Effect.runPromise(Effect.scoped(program));
```

`interpret()` returns an `Effect` requiring a `Scope` — running it inside `Effect.scoped` ties the actor's lifetime (and any `activities`/`run` streams it starts) to that scope.

### Transitions

```typescript
{ target: "nextState", actions: [assign({ count: 0 })] }  // move + update context
{ actions: [assign(({ context }) => ({ count: context.count + 1 }))] }  // stay, update context
{ target: "nextState" }                                    // move, no context change
```

## React Integration

```bash
npm install @archstate/react @archstate/core effect react
```

`@archstate/react` doesn't wrap machine creation in an opinionated `useActor` hook — instead it gives you `createUseMachineHook`, a typed factory over `effect/unstable/reactivity`'s `Atom`, so you wire the actor's atom to your own app runtime:

```tsx
import { Effect, Layer, SubscriptionRef } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { createUseMachineHook } from "@archstate/react";
import { interpret } from "@archstate/core";
import { machine } from "./machine";

const runtime = Atom.runtime(Layer.empty); // provide your app's services here

const actorAtom = runtime.atom(interpret(machine)).pipe(Atom.keepAlive);

const snapshotAtom = runtime
  .subscriptionRef((get) =>
    Effect.gen(function* () {
      const actor = yield* get.result(actorAtom);
      const ref = yield* SubscriptionRef.make(actor.getSnapshot());
      actor.subscribe((snapshot) => Effect.runSync(SubscriptionRef.set(ref, snapshot)));
      return ref;
    }),
  )
  .pipe(Atom.keepAlive);

const useLight = createUseMachineHook(actorAtom, snapshotAtom, machine.initialSnapshot);

function Light() {
  const { state, context, send, isLoading } = useLight();
  return isLoading ? null : (
    <button onClick={() => send(new Toggle())}>
      {state} ({context.count})
    </button>
  );
}
```

The hook resolves atoms against a shared default registry, so no provider setup is required to get started. Registry isolation (e.g. for tests) is an internal, not-yet-public API — see `packages/react/src/internal/reactivity-react.ts`.

## Development

This is a monorepo managed with [Turborepo](https://turbo.build/) and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## Project Structure

```
.
├── packages/
│   ├── core/    # @archstate/core - state machine engine
│   └── react/   # @archstate/react - React integration
```

## License

MIT
