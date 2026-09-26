import assert from "node:assert/strict";
import test from "node:test";
import { openHdfSession } from "../apps/geolibre-desktop/src/lib/hdf-session-client";

class WorkerStub {
  static instances: WorkerStub[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  onmessageerror?: () => void;
  terminated = false;
  messages: { id: number; type: string }[] = [];
  constructor() {
    WorkerStub.instances.push(this);
    queueMicrotask(() => this.onmessage?.({ data: { ready: true } }));
  }
  postMessage(message: { id: number; type: string }): void {
    this.messages.push(message);
    if (message.type === "open")
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: null } }));
  }
  terminate(): void {
    this.terminated = true;
  }
}

async function withWorker(run: () => Promise<void>) {
  const previous = globalThis.Worker;
  globalThis.Worker = WorkerStub as unknown as typeof Worker;
  WorkerStub.instances = [];
  try {
    await run();
  } finally {
    globalThis.Worker = previous;
  }
}

test("HDF client enforces four-session cap and releases capacity on close", () =>
  withWorker(async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => openHdfSession(new Blob())));
    try {
      await assert.rejects(openHdfSession(new Blob()), /four/);
      sessions[0].close();
      sessions[0].close();
      const next = await openHdfSession(new Blob());
      next.close();
    } finally {
      sessions.forEach((session) => session.close());
    }
    assert.ok(WorkerStub.instances.every((worker) => worker.terminated));
  }));

test("HDF cancellation terminates the worker and rejects current and future reads", () =>
  withWorker(async () => {
    const session = await openHdfSession(new Blob());
    const controller = new AbortController();
    const pending = session.describe("/", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(session.listChildren(), { name: "AbortError" });
    assert.equal(WorkerStub.instances[0].terminated, true);
    session.close();
  }));

test("HDF worker errors settle all pending reads without leaking a slot", () =>
  withWorker(async () => {
    const session = await openHdfSession(new Blob());
    const pending = session.describe("/");
    WorkerStub.instances[0].onerror?.({ message: "WASM failed" });
    await assert.rejects(pending, /WASM failed/);
    await assert.rejects(session.readAttributes("/"), /WASM failed/);
    const next = await openHdfSession(new Blob());
    next.close();
  }));

test("HDF pre-aborted open does not create a worker", () =>
  withWorker(async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(openHdfSession(new Blob(), { signal: controller.signal }), {
      name: "AbortError",
    });
    assert.equal(WorkerStub.instances.length, 0);
  }));

test("HDF pending requests are bounded and capacity returns after a reply", () =>
  withWorker(async () => {
    const session = await openHdfSession(new Blob());
    const pending = Array.from({ length: 4 }, () => session.describe("/"));
    const settled = Promise.allSettled(pending);
    await assert.rejects(session.describe("/"), /four HDF requests/);
    const worker = WorkerStub.instances[0];
    assert.equal(worker.messages.length, 5);
    worker.onmessage?.({
      data: { id: worker.messages[1].id, ok: true, result: { path: "/", kind: "group" } },
    });
    await pending[0];
    const next = session.describe("/");
    session.close();
    await assert.rejects(next, /closed/);
    await settled;
  }));
