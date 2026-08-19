/**
 * Minimal React bindings for Effect v4's built-in `effect/unstable/reactivity`
 * module.
 *
 * `effect/unstable/reactivity` ships the atom/registry engine itself (what
 * used to live in the standalone `@effect-atom/atom` package that
 * `@effect-atom/atom-react` builds its hooks on top of), but it does not ship
 * any React bindings. `@effect-atom/atom-react` has not published a version
 * compatible with Effect v4 — its latest release (0.7.0) still peer-depends
 * on `effect ^3.22.1`, and its `RegistryProvider`/`useAtomValue` construct
 * Effect-v3-shaped runtime values that throw `RuntimeException: Not a valid
 * effect` when handed the v4-shaped objects `@archstate/core` produces.
 *
 * This file ports the handful of hooks ArchState's React integration
 * actually needs (`RegistryProvider`, `useAtomValue`) directly on top of
 * `effect/unstable/reactivity`'s `Atom`/`AtomRegistry`, using the same
 * `useSyncExternalStore`-over-`AtomRegistry.subscribe` shape as upstream
 * `@effect-atom/atom-react`'s implementation (see
 * https://github.com/tim-smart/effect-atom/blob/main/packages/atom-react/src/Hooks.ts
 * and .../RegistryContext.ts).
 */
import * as React from "react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

const RegistryContext = React.createContext<AtomRegistry.AtomRegistry>(AtomRegistry.make());

export interface RegistryProviderProps {
  readonly children?: React.ReactNode;
}

/**
 * Provides an isolated `AtomRegistry` to the component tree below it, so
 * atom state doesn't leak across independently-mounted subtrees (e.g. tests).
 * The registry is created once per mount and disposed on unmount.
 *
 * Disposal is debounced rather than immediate: `AtomRegistry.dispose()` is
 * permanent (a disposed registry throws on every subsequent access), but
 * React 18 StrictMode's dev-mode mount→cleanup→mount cycle would otherwise
 * dispose the registry created at first render before the second render's
 * effect runs, leaving `ref.current` pointing at a dead registry. Delaying
 * disposal and cancelling it if the effect re-runs first (matching upstream
 * `@effect-atom/atom-react`'s `RegistryContext.tsx`) avoids that.
 */
export const RegistryProvider = (props: RegistryProviderProps): React.ReactElement => {
  const ref = React.useRef<AtomRegistry.AtomRegistry | null>(null);
  const disposeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  if (ref.current === null) {
    ref.current = AtomRegistry.make();
  }
  React.useEffect(() => {
    // A disposal was pending from a previous (StrictMode) cleanup — cancel
    // it, this mount is reusing the same still-live registry.
    if (disposeTimeoutRef.current !== null) {
      clearTimeout(disposeTimeoutRef.current);
      disposeTimeoutRef.current = null;
    }
    return () => {
      const registry = ref.current;
      disposeTimeoutRef.current = setTimeout(() => {
        registry?.dispose();
        if (ref.current === registry) {
          ref.current = null;
        }
        disposeTimeoutRef.current = null;
      }, 500);
    };
  }, []);
  return React.createElement(RegistryContext.Provider, { value: ref.current }, props.children);
};

/**
 * Reads and subscribes to an atom's current value from the nearest
 * `RegistryProvider` (or the module-level default registry if none is
 * mounted).
 */
export function useAtomValue<A>(atom: Atom.Atom<A>): A {
  const registry = React.useContext(RegistryContext);
  const getSnapshot = React.useCallback(() => registry.get(atom), [registry, atom]);
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => registry.subscribe(atom, onStoreChange),
    [registry, atom],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot);
}
