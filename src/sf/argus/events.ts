import type { AppEvent, EventBus } from './contracts';

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(e: AppEvent) => void>>();
  return {
    emit(e) {
      handlers.get(e.type)?.forEach((fn) => fn(e));
    },
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn as (e: AppEvent) => void);
      return () => set!.delete(fn as (e: AppEvent) => void);
    },
  };
}
