/**
 * Characterization tests for packages/react/src/atom.ts (the root,
 * effect/unstable/reactivity-based hook factory API).
 */
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Data, Effect, Layer, Schema, SubscriptionRef } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { createMachine, interpret, assign, spawnChild, type MachineActor } from "@archstate/core";
import { createUseMachineHook, createUseChildMachineHook, selectContext, selectState } from "../src/atom";
import { RegistryProvider } from "../src/internal/reactivity-react";

// ============================================================================
// Test Machine: a simple two-state light with a toggle counter
// ============================================================================

class Toggle extends Data.TaggedClass("Toggle")<{}> {}
type LightEvent = Toggle;
type LightState = "off" | "on";

const ContextSchema = Schema.Struct({ count: Schema.Number });
type LightContext = Schema.Schema.Type<typeof ContextSchema>;

function createLightMachine() {
  return createMachine<LightState, LightEvent, LightContext, LightContext, never>({
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
}

/** Builds a fresh actorAtom/snapshotAtom pair and hook, mirroring the demo app's wiring. */
function makeLightHook() {
  const machine = createLightMachine();
  const runtime = Atom.runtime(Layer.empty);

  const actorAtom = runtime.atom(interpret(machine)).pipe(Atom.keepAlive);

  const snapshotAtom = runtime
    .subscriptionRef((get) =>
      Effect.gen(function* () {
        const actor = yield* get.result(actorAtom);
        const ref = yield* SubscriptionRef.make(actor.getSnapshot());
        actor.subscribe((snapshot) => {
          Effect.runSync(SubscriptionRef.set(ref, snapshot));
        });
        return ref;
      })
    )
    .pipe(Atom.keepAlive);

  const useLight = createUseMachineHook(actorAtom, snapshotAtom, machine.initialSnapshot);
  return { machine, runtime, actorAtom, useLight };
}

// A fresh RegistryProvider per test isolates atom state between tests.
const wrapper = ({ children }: { children?: React.ReactNode }) =>
  React.createElement(RegistryProvider, null, children);

describe("createUseMachineHook", () => {
  it("starts loading with the provided initialSnapshot, then resolves to the actor's live state", async () => {
    const { machine, useLight } = makeLightHook();
    const { result } = renderHook(() => useLight(), { wrapper });

    // CHARACTERIZATION: for a machine with no async requirements (R = never,
    // Layer.empty runtime), the actor/snapshot atoms resolve synchronously
    // within the mounting render - isLoading is already false on first read,
    // and the initialSnapshot argument is never actually observed here.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.snapshot).toEqual(machine.initialSnapshot);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.state).toBe("off");
    expect(result.current.context).toEqual({ count: 0 });
  });

  it("re-renders with the new snapshot after send() causes a transition", async () => {
    const { useLight } = makeLightHook();
    const { result } = renderHook(() => useLight(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.send(new Toggle());
    });

    expect(result.current.state).toBe("on");
    expect(result.current.context.count).toBe(1);
  });

  it("matches() reflects the current state value", async () => {
    const { useLight } = makeLightHook();
    const { result } = renderHook(() => useLight(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.matches("off")).toBe(true);
    expect(result.current.matches("on")).toBe(false);

    await act(async () => {
      result.current.send(new Toggle());
    });

    expect(result.current.matches("on")).toBe(true);
    expect(result.current.matches("off")).toBe(false);
  });

  it("send() is a no-op while the actor atom has not resolved yet", () => {
    // Force a permanently-unresolved actor atom (Effect.never) to observe the
    // isLoading branch deterministically, since a real machine's actor/snapshot
    // atoms resolve synchronously (see previous test).
    const machine = createLightMachine();
    const runtime = Atom.runtime(Layer.empty);
    const stuckActorAtom = runtime
      .atom(Effect.never as Effect.Effect<MachineActor<LightState, { count: number }, LightEvent>>)
      .pipe(Atom.keepAlive);
    const stuckSnapshotAtom = runtime
      .subscriptionRef((get) =>
        Effect.gen(function* () {
          const actor = yield* get.result(stuckActorAtom);
          return yield* SubscriptionRef.make(actor.getSnapshot());
        })
      )
      .pipe(Atom.keepAlive);
    const useStuck = createUseMachineHook(stuckActorAtom, stuckSnapshotAtom, machine.initialSnapshot);

    const { result } = renderHook(() => useStuck(), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(() => result.current.send(new Toggle())).not.toThrow();
    // Falls back to the initialSnapshot argument while unresolved.
    expect(result.current.snapshot).toEqual(machine.initialSnapshot);
  });

  it("unmounts cleanly, tearing down the RegistryProvider's registry (and the actor's Scope finalizer) without throwing", async () => {
    // UseMachineResult doesn't expose the actor instance directly, so we can't
    // spy on its `stop()` from here. What we *can* characterize: unmounting a
    // component whose atoms are Atom.keepAlive (backed by interpret()'s
    // Scope-bound finalizer that calls actor.stop()) must not throw, even
    // though the RegistryProvider wrapper unmounts (and disposes its registry)
    // in the same act().
    const { useLight } = makeLightHook();
    const { result, unmount } = renderHook(() => useLight(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(() => unmount()).not.toThrow();
  });
});

describe("selectContext / selectState", () => {
  it("selectContext extracts a value from the snapshot's context", () => {
    const select = selectContext((ctx: { count: number }) => ctx.count);
    expect(select({ value: "off", context: { count: 3 }, event: null } as never)).toBe(3);
  });

  it("selectState reports whether the snapshot's value matches the given state", () => {
    const isOn = selectState("on");
    expect(isOn({ value: "on", context: {}, event: null } as never)).toBe(true);
    expect(isOn({ value: "off", context: {}, event: null } as never)).toBe(false);
  });
});

describe("createUseChildMachineHook", () => {
  function createChildMachine() {
    return createMachine<LightState, LightEvent, LightContext, LightContext, never>({
      id: "childLight",
      initial: "off",
      context: ContextSchema,
      initialContext: { count: 0 },
      states: {
        off: { on: { Toggle: { target: "on" } } },
        on: { on: { Toggle: { target: "off" } } },
      },
    });
  }

  function createParentMachine(childMachine: ReturnType<typeof createChildMachine>) {
    return createMachine<"idle", LightEvent, LightContext, LightContext, never>({
      id: "parent",
      initial: "idle",
      context: ContextSchema,
      initialContext: { count: 0 },
      states: {
        idle: {
          entry: [spawnChild(childMachine, { id: "child1" })],
        },
      },
    });
  }

  function makeParentChildHooks() {
    const childMachine = createChildMachine();
    const parentMachine = createParentMachine(childMachine);
    const runtime = Atom.runtime(Layer.empty);

    const parentActorAtom = runtime.atom(interpret(parentMachine)).pipe(Atom.keepAlive);
    const parentSnapshotAtom = runtime
      .subscriptionRef((get) =>
        Effect.gen(function* () {
          const actor = yield* get.result(parentActorAtom);
          const ref = yield* SubscriptionRef.make(actor.getSnapshot());
          actor.subscribe((s) => Effect.runSync(SubscriptionRef.set(ref, s)));
          return ref;
        })
      )
      .pipe(Atom.keepAlive);

    const useParent = createUseMachineHook(parentActorAtom, parentSnapshotAtom, parentMachine.initialSnapshot);
    const useChild = createUseChildMachineHook<
      "idle",
      { count: number },
      LightEvent,
      LightState,
      { count: number },
      LightEvent
    >(runtime, parentActorAtom, "child1", childMachine.initialSnapshot);

    return { useParent, useChild };
  }

  it("resolves the spawned child's live snapshot once the parent actor is available", async () => {
    const { useChild } = makeParentChildHooks();
    const { result } = renderHook(() => useChild(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.state).toBe("off");
  });

  it("forwards send() to the child actor and re-renders on child transitions", async () => {
    const { useChild } = makeParentChildHooks();
    const { result } = renderHook(() => useChild(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.send(new Toggle());
    });

    expect(result.current.state).toBe("on");
  });
});
