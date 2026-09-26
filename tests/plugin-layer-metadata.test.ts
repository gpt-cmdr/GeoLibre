import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  parseProject,
  projectFromStore,
  redactProjectCredentials,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import type { JsonValue } from "../packages/plugins/src/types";
import { createPluginLayerMetadata } from "../apps/geolibre-desktop/src/lib/plugin-layer-metadata";

const api = createPluginLayerMetadata();
beforeEach(() => {
  useAppStore.getState().loadProject(createEmptyProject("Metadata test"));
  useAppStore.setState({
    layers: [
      {
        id: "layer",
        name: "Layer",
        type: "geojson",
        source: { type: "geojson" },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: { sourceKind: "internal", user: { other: { unchanged: true } } },
        geojson: { type: "FeatureCollection", features: [] },
      },
    ],
    isDirty: false,
  });
});

test("namespaced layer metadata preserves internal keys and copies inputs and outputs", () => {
  const value = { units: "m", provenance: { model: "Example" } };
  assert.equal(api.setLayerUserMetadata("layer", "flood-reader", value), true);
  value.provenance.model = "changed after write";
  assert.deepEqual(api.getLayerUserMetadata("layer", "flood-reader"), {
    units: "m",
    provenance: { model: "Example" },
  });
  const copy = api.getLayerUserMetadata("layer", "flood-reader") as {
    provenance: { model: string };
  };
  copy.provenance.model = "changed after read";
  assert.equal(
    (api.getLayerUserMetadata("layer", "flood-reader") as { provenance: { model: string } })
      .provenance.model,
    "Example",
  );
  assert.equal(useAppStore.getState().layers[0]!.metadata.sourceKind, "internal");
  assert.deepEqual(api.getLayerUserMetadata("layer", "other"), { unchanged: true });
  assert.equal(useAppStore.getState().isDirty, true);
  assert.equal(api.setLayerUserMetadata("layer", "flood-reader", null), true);
  assert.equal(api.getLayerUserMetadata("layer", "flood-reader"), null);
});

test("missing layers and unsafe namespaces cannot mutate metadata", () => {
  const before = structuredClone(useAppStore.getState().layers[0]!.metadata);
  assert.equal(api.setLayerUserMetadata("missing", "plugin", {}), false);
  for (const name of [
    "",
    "__proto__",
    "constructor",
    "prototype",
    "plugin/child",
    "x".repeat(129),
  ]) {
    assert.equal(api.setLayerUserMetadata("layer", name, {}), false);
    assert.equal(api.getLayerUserMetadata("layer", name), undefined);
  }
  assert.deepEqual(useAppStore.getState().layers[0]!.metadata, before);
  assert.equal(useAppStore.getState().isDirty, false);
});

test("rejects executable, binary, cyclic, and non-JSON object values without invoking accessors", () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  class Handle {
    value = 1;
  }
  const invalid: unknown[] = [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    new Date(),
    new Map(),
    new Handle(),
    new Uint8Array([1]),
    new ArrayBuffer(4),
    new Blob(["x"]),
    Promise.resolve(1),
    accessor,
    cyclic,
    new Array(3),
    { value: undefined },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ];
  for (const value of invalid)
    assert.equal(api.setLayerUserMetadata("layer", "plugin", value as JsonValue), false);
  assert.equal(invoked, false);
  assert.equal(api.getLayerUserMetadata("layer", "plugin"), undefined);
  assert.equal(useAppStore.getState().isDirty, false);
});

test("enforces serialized UTF-8 size, depth, and node budgets", () => {
  assert.equal(api.setLayerUserMetadata("layer", "plugin", "é".repeat(128 * 1024)), false);
  assert.equal(api.setLayerUserMetadata("layer", "plugin", Array(10_000).fill(null)), false);
  let deep: JsonValue = null;
  for (let index = 0; index < 33; index++) deep = [deep];
  assert.equal(api.setLayerUserMetadata("layer", "plugin", deep), false);
  assert.equal(api.setLayerUserMetadata("layer", "plugin", "x".repeat(256 * 1024 - 2)), true);
  assert.equal(api.setLayerUserMetadata("layer", "plugin", "x".repeat(256 * 1024 - 1)), false);
});

test("portable metadata survives real project save/reopen and sharing redaction", () => {
  const value = {
    units: "ft",
    provenance: { producer: "Example exporter", planId: "p01" },
    apiKey: "secret-value",
    sourceUrl: "https://example.org/data?token=secret-value",
  };
  assert.equal(api.setLayerUserMetadata("layer", "flood-reader", value), true);
  const saved = serializeProject(projectFromStore(useAppStore.getState()));
  useAppStore.getState().loadProject(parseProject(saved));
  assert.deepEqual(api.getLayerUserMetadata("layer", "flood-reader"), value);
  const shared = redactProjectCredentials(projectFromStore(useAppStore.getState())).project;
  const portable = serializeProject(shared);
  assert.ok(!portable.includes("secret-value"));
  useAppStore.getState().loadProject(parseProject(portable));
  const read = api.getLayerUserMetadata("layer", "flood-reader") as Record<string, JsonValue>;
  assert.equal(read.units, "ft");
  assert.deepEqual(read.provenance, { producer: "Example exporter", planId: "p01" });
  assert.deepEqual(api.getLayerUserMetadata("layer", "other"), { unchanged: true });
});

test("unexpected existing user metadata is preserved rather than overwritten", () => {
  useAppStore.getState().updateLayer("layer", { metadata: { user: "legacy-value" } });
  assert.equal(api.setLayerUserMetadata("layer", "plugin", {}), false);
  assert.equal(useAppStore.getState().layers[0]!.metadata.user, "legacy-value");
  assert.equal(api.getLayerUserMetadata("layer", "plugin"), undefined);
});
