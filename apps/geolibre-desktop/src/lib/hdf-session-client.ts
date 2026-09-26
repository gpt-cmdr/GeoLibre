import { HDF_LIMITS, type HdfReadOptions, type HdfSession } from "@geolibre/plugins/hdf-types";
import type { HdfResponse } from "../workers/hdf.worker";

let sessions = 0;
/** Open one host-owned worker. Abort is terminal because HDF calls are synchronous. */
export async function openHdfSession(
  blob: Blob,
  options: HdfReadOptions = {},
): Promise<HdfSession> {
  options.signal?.throwIfAborted();
  if (!(blob instanceof Blob) || blob.size > HDF_LIMITS.sourceBytes)
    throw new Error("Invalid or oversized HDF source");
  if (sessions >= 4) throw new Error("At most four HDF sessions may be open");
  const worker = new Worker(new URL("../workers/hdf.worker.ts", import.meta.url), {
    type: "module",
  });
  sessions++;
  let terminal: Error | undefined;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; detach: () => void }
  >();
  const listeners = new Set<() => void>();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(
    () => close(new Error("HDF worker did not start within 20 seconds")),
    20000,
  );

  function close(error = new Error("HDF session is closed")): void {
    if (terminal) return;
    terminal = error;
    clearTimeout(timeout);
    readyReject(error);
    for (const entry of pending.values()) {
      entry.detach();
      entry.reject(error);
    }
    pending.clear();
    for (const detach of listeners) detach();
    listeners.clear();
    worker.terminate();
    sessions--;
  }
  function bind(signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const abort = () => close(new DOMException("HDF session cancelled", "AbortError"));
    if (signal.aborted) {
      abort();
      return () => {};
    }
    signal.addEventListener("abort", abort, { once: true });
    const detach = () => {
      signal.removeEventListener("abort", abort);
      listeners.delete(detach);
    };
    listeners.add(detach);
    return detach;
  }
  worker.onmessage = (event: MessageEvent<HdfResponse>) => {
    const message = event.data;
    if ("ready" in message) {
      clearTimeout(timeout);
      readyResolve();
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.detach();
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  };
  worker.onerror = (event) => close(new Error(event.message || "HDF worker failed"));
  worker.onmessageerror = () => close(new Error("HDF worker response could not be decoded"));
  function send<T>(message: Record<string, unknown>, readOptions: HdfReadOptions = {}): Promise<T> {
    const detach = bind(readOptions.signal);
    if (terminal) {
      detach();
      return Promise.reject(terminal);
    }
    if (pending.size >= 4) {
      detach();
      return Promise.reject(new Error("At most four HDF requests may be pending per session"));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject, detach });
      try {
        worker.postMessage({ ...message, id });
      } catch (error) {
        close(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  bind(options.signal);
  try {
    await ready;
    await send({ type: "open", blob });
    return {
      version: 1,
      limits: HDF_LIMITS,
      describe: (path, opts) => send({ type: "describe", path }, opts),
      listChildren: (path = "/", opts) => send({ type: "listChildren", path }, opts),
      readAttributes: (path, opts) => send({ type: "readAttributes", path }, opts),
      readDataset: (path, selection, opts) => send({ type: "readDataset", path, selection }, opts),
      close: () => close(),
    };
  } catch (error) {
    close(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
