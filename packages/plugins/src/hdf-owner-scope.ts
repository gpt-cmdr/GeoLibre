import type { HdfReadOptions, HdfSession } from "./hdf-types";
type Open = (blob: Blob, options?: HdfReadOptions) => Promise<HdfSession>;
interface Scope {
  active: boolean;
  controllers: Set<AbortController>;
  sessions: Set<HdfSession>;
}
const scopes = new Map<string, Scope>();

/** Bind lifetime to the registering activation, including opens completing late. */
export function scopedHdfOpen(owner: string, open: Open, live: () => boolean): Open {
  let scope = scopes.get(owner);
  if (!scope) {
    scope = { active: true, controllers: new Set(), sessions: new Set() };
    scopes.set(owner, scope);
  }
  const owned = scope;
  return async (blob, options = {}) => {
    if (!owned.active || !live()) throw new Error("HDF plugin activation is no longer active");
    const controller = new AbortController();
    owned.controllers.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const session = await open(blob, { signal: controller.signal });
      if (!owned.active || !live() || controller.signal.aborted) {
        session.close();
        throw new DOMException("HDF plugin activation ended", "AbortError");
      }
      const originalClose = session.close.bind(session);
      let closed = false;
      const read = async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        // The client handles the AbortError, while this wrapper drops ownership.
        try {
          return await action();
        } finally {
          if (signal?.aborted) wrapped.close();
        }
      };
      const wrapped: HdfSession = {
        ...session,
        close() {
          if (closed) return;
          closed = true;
          originalClose();
          owned.sessions.delete(wrapped);
          owned.controllers.delete(controller);
          controller.signal.removeEventListener("abort", wrapped.close);
          options.signal?.removeEventListener("abort", abort);
        },
        describe: (path, opts) => read(() => session.describe(path, opts), opts?.signal),
        listChildren: (path, opts) => read(() => session.listChildren(path, opts), opts?.signal),
        readAttributes: (path, opts) =>
          read(() => session.readAttributes(path, opts), opts?.signal),
        readDataset: (path, selection, opts) =>
          read(() => session.readDataset(path, selection, opts), opts?.signal),
      };
      owned.sessions.add(wrapped);
      controller.signal.addEventListener("abort", wrapped.close, { once: true });
      return wrapped;
    } catch (error) {
      owned.controllers.delete(controller);
      options.signal?.removeEventListener("abort", abort);
      throw error;
    }
  };
}

export function closeHdfSessionsByOwner(owner: string): void {
  const scope = scopes.get(owner);
  if (!scope) return;
  scope.active = false;
  for (const controller of scope.controllers) controller.abort();
  for (const session of scope.sessions) session.close();
  scopes.delete(owner);
}
