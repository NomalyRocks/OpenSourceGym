import { createContext, useContext } from "react";

/**
 * Lets a nested horizontal scroller (Home's gym cards) hold the tab pager still
 * while a finger is on it. `lock`/`unlock` are reference counted by the
 * provider, so every `lock` must be paired with an `unlock`.
 */
export interface TabSwipeLock {
  lock: () => void;
  unlock: () => void;
}

export const TabSwipeLockContext = createContext<TabSwipeLock>({
  lock: () => undefined,
  unlock: () => undefined,
});

export function useTabSwipeLock(): TabSwipeLock {
  return useContext(TabSwipeLockContext);
}
