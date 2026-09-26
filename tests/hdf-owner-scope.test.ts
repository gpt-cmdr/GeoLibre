import assert from "node:assert/strict";
import test from "node:test";
import { scopedHdfOpen, closeHdfSessionsByOwner } from "../packages/plugins/src/hdf-owner-scope";
import { HDF_LIMITS, type HdfSession } from "../packages/plugins/src/hdf-types";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

function session(close: () => void): HdfSession {
  return {
    version: 1,
    limits: HDF_LIMITS,
    close,
    describe: async () => ({ path: "/", kind: "group" }),
    listChildren: async () => [],
    readAttributes: async () => ({}),
    readDataset: async () => ({
      shape: [0],
      dtype: { kind: "integer", bytes: 1 },
      values: new Uint8Array(),
    }),
  };
}
test("plugin teardown cancels outstanding opens and closes late replies", async () => {
  let finish!: (session: HdfSession) => void;
  let signal: AbortSignal | undefined;
  const open = scopedHdfOpen(
    "late-hdf-test",
    async (_blob, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => true,
  );
  let closed = 0;
  const opening = open(new Blob());
  closeHdfSessionsByOwner("late-hdf-test");
  assert.equal(signal?.aborted, true);
  finish(session(() => closed++));
  await assert.rejects(opening, /activation ended/);
  assert.equal(closed, 1);
  await assert.rejects(open(new Blob()), /no longer active/);
});
test("owner disposal releases sessions without affecting another plugin", async () => {
  let a = 0,
    b = 0;
  const one = scopedHdfOpen(
    "hdf-a",
    async () => session(() => a++),
    () => true,
  );
  const two = scopedHdfOpen(
    "hdf-b",
    async () => session(() => b++),
    () => true,
  );
  await one(new Blob());
  await two(new Blob());
  closeHdfSessionsByOwner("hdf-a");
  assert.equal(a, 1);
  assert.equal(b, 0);
  closeHdfSessionsByOwner("hdf-b");
  assert.equal(b, 1);
});

test("aborting the open signal drops owned sessions and closes only once", async () => {
  let closed = 0;
  const controller = new AbortController();
  const open = scopedHdfOpen(
    "hdf-abort-owner",
    async () => session(() => closed++),
    () => true,
  );
  const handle = await open(new Blob(), { signal: controller.signal });
  controller.abort();
  assert.equal(closed, 1);
  closeHdfSessionsByOwner("hdf-abort-owner");
  handle.close();
  assert.equal(closed, 1);
});

test("actual PluginManager closes owned sessions even when a plugin forgets cleanup", async () => {
  const manager = new PluginManager();
  let closed = 0;
  let opening: Promise<HdfSession> | undefined;
  let captured: GeoLibreAppAPI | undefined;
  const app = { openHdfSession: async () => session(() => closed++) } as GeoLibreAppAPI;
  manager.register({
    id: "hdf-managed",
    name: "HDF",
    version: "1",
    activate(scoped) {
      captured = scoped;
      opening = scoped.openHdfSession!(new Blob());
    },
    deactivate() {},
  });
  await manager.activate("hdf-managed", app);
  await opening;
  manager.deactivate("hdf-managed", app);
  assert.equal(closed, 1);
  await assert.rejects(captured!.openHdfSession!(new Blob()), /no longer active/);
});
