import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HdfReader,
  boundedDecodedValues,
  boundedElements,
  hdfDtype,
  hdfPath,
} from "../packages/plugins/src/plugins/hdf-reader";
import { HDF_LIMITS } from "../packages/plugins/src/hdf-types";

test("HDF reads reject unsafe selection arithmetic before allocating", () => {
  assert.equal(boundedElements([], 8, 8), 1);
  assert.equal(boundedElements([0, 900000], 8, 8), 0);
  assert.throws(
    () => boundedElements([2 ** 40, 2 ** 40], 1, HDF_LIMITS.readBytes),
    /safe indexing/,
  );
  assert.throws(
    () => boundedElements([HDF_LIMITS.readBytes + 1], 1, HDF_LIMITS.readBytes),
    /byte limit/,
  );
  assert.throws(() => boundedElements([-1], 4, 1024), /shape/);
  assert.throws(() => hdfPath("/Geometry/../Results"), /path/);
});

test("HDF type declaration refuses unbounded values and unsupported compound members", () => {
  const base = { type: 3, size: 32, signed: false, shape: [] };
  assert.equal(hdfDtype(base).kind, "string");
  assert.equal(hdfDtype({ ...base, vlen: true }).kind, "unsupported");
  assert.equal(hdfDtype({ ...base, type: 7 }).kind, "unsupported");
  assert.equal(
    hdfDtype({
      ...base,
      type: 6,
      compound_type: { members: [{ ...base, name: "name", offset: 0, vlen: true }] },
    }).kind,
    "unsupported",
  );
});

test("fixed strings and compound rows have an independent decoded-object budget", () => {
  assert.throws(
    () => boundedDecodedValues({ kind: "string", bytes: 1 }, 100001),
    /decoded value limit/,
  );
  assert.throws(
    () =>
      boundedDecodedValues(
        {
          kind: "compound",
          bytes: 1,
          members: [{ name: "x", dtype: { kind: "integer", bytes: 1 } }],
        },
        50001,
      ),
    /decoded value limit/,
  );
  assert.equal(boundedDecodedValues({ kind: "integer", bytes: 1 }, 100001), 0);
});

test("oversized expanded chunks reject before invoking the native hyperslab reader", () => {
  let reads = 0;
  const entity = {
    shape: [20000000],
    metadata: { type: 0, size: 1, signed: false, shape: [20000000], chunks: [20000000] },
    slice: () => {
      reads++;
      return new Uint8Array(1);
    },
  };
  // Inject only the filesystem boundary to prove ordering before native read.
  const reader = Object.create(HdfReader.prototype) as HdfReader;
  Object.assign(reader, { file: { get: () => entity }, closed: false });
  assert.throws(
    () => reader.readDataset("/compressed", { start: [0], count: [1] }),
    /chunk exceeds/,
  );
  assert.equal(reads, 0);
});

test("attribute decoded-value budget aggregates before any attribute is read", () => {
  let reads = 0;
  const attr = {
    metadata: { type: 3, size: 1, signed: false, shape: [60000] },
    shape: [60000],
    get value() {
      reads++;
      return [];
    },
  };
  const reader = Object.create(HdfReader.prototype) as HdfReader;
  Object.assign(reader, { file: { attrs: { a: attr, b: attr } }, closed: false });
  assert.throws(() => reader.readAttributes("/"), /decoded value limit/);
  assert.equal(reads, 0);
});

test("real independent HDF fixture supports raw hyperslabs without NetCDF coordinates", async () => {
  const bytes = readFileSync(new URL("./fixtures/sample-hdf5.h5", import.meta.url));
  const reader = await HdfReader.open(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  try {
    const children = reader.listChildren();
    assert.ok(children.length > 0);
    const dataset = children.find(
      (node) => node.kind === "dataset" && node.shape?.length && node.dtype?.kind === "float",
    );
    assert.ok(dataset?.shape);
    const count = dataset.shape.map(() => 1);
    const result = reader.readDataset(dataset.path, { start: count.map(() => 0), count });
    assert.deepEqual(result.shape, count);
    assert.ok(ArrayBuffer.isView(result.values));
    assert.throws(() => reader.readDataset(dataset.path, { start: [], count: [] }), /rank/);
    assert.throws(
      () => reader.readDataset(dataset.path, { start: dataset.shape!, count }),
      /outside/,
    );
  } finally {
    reader.close();
  }
  reader.close();
  assert.throws(() => reader.listChildren(), /closed/);
});

test(
  "real HEC-RAS compound metadata and geometry remain raw and index-aligned",
  { skip: !process.env.GEOLIBRE_RAS_HDF_FIXTURE },
  async () => {
    const bytes = readFileSync(process.env.GEOLIBRE_RAS_HDF_FIXTURE!);
    const reader = await HdfReader.open(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    try {
      assert.equal(reader.readAttributes("/Geometry").Title, "Base Geometry Data");
      const node = reader.describe("/Geometry/Cross Sections/Attributes");
      assert.deepEqual(node.shape, [10]);
      const data = reader.readDataset(node.path, { start: [0], count: [1] });
      assert.equal(data.dtype.kind, "compound");
      assert.deepEqual(
        data.dtype.members?.slice(0, 3).map((field) => field.name),
        ["River", "Reach", "RS"],
      );
      assert.ok(Array.isArray(data.values));
      assert.deepEqual((data.values[0] as unknown[]).slice(0, 3), [
        "Butte Cr.",
        "Tributary",
        "0.2",
      ]);
      const points = reader.readDataset("/Geometry/Cross Sections/Polyline Points", {
        start: [0, 0],
        count: [2, 2],
      });
      assert.deepEqual(points.shape, [2, 2]);
      assert.ok(points.values instanceof Float32Array || points.values instanceof Float64Array);
    } finally {
      reader.close();
    }
  },
);
