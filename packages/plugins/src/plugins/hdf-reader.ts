import {
  HDF_LIMITS,
  type HdfDtype,
  type HdfNode,
  type HdfReadResult,
  type HdfSelection,
  type HdfValue,
} from "../hdf-types";
import { loadH5wasm, type H5File, type H5Metadata } from "./hdf-runtime";

interface Entity {
  keys?: () => string[];
  shape?: number[] | null;
  metadata?: H5Metadata;
  attrs?: Record<string, { metadata: H5Metadata; shape: number[] | null; value: unknown }>;
  value?: unknown;
  slice?: (ranges: [number, number][]) => unknown;
}

export function hdfPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.split("/").some((p) => p === "." || p === "..")
  ) {
    throw new Error("Invalid HDF path");
  }
  return "/" + path.split("/").filter(Boolean).join("/");
}

export function hdfDtype(meta: H5Metadata, depth = 0): HdfDtype {
  const unsupported: HdfDtype = { kind: "unsupported", bytes: meta.size };
  if (depth > 8 || meta.vlen || !Number.isSafeInteger(meta.size) || meta.size <= 0)
    return unsupported;
  if (meta.type === 0 && [1, 2, 4, 8].includes(meta.size))
    return { kind: "integer", bytes: meta.size, signed: meta.signed };
  if (meta.type === 1 && [4, 8].includes(meta.size)) return { kind: "float", bytes: meta.size };
  if (meta.type === 3) return { kind: "string", bytes: meta.size };
  if (
    meta.type === 6 &&
    meta.compound_type?.members.length &&
    meta.compound_type.members.length <= 256
  ) {
    const members = meta.compound_type.members.map((m) => ({
      name: m.name,
      dtype: hdfDtype(m, depth + 1),
    }));
    if (members.every((m) => m.dtype.kind !== "unsupported"))
      return { kind: "compound", bytes: meta.size, members };
  }
  return unsupported;
}

export function boundedElements(shape: number[], bytes: number, limit: number): number {
  let count = 1;
  for (const n of shape) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid HDF shape");
    count *= n;
    if (!Number.isSafeInteger(count)) throw new Error("HDF shape exceeds safe indexing");
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || count > Math.floor(limit / bytes))
    throw new Error("HDF read exceeds byte limit");
  return count;
}

function value(input: unknown): HdfValue {
  if (typeof input === "string" || typeof input === "number" || typeof input === "bigint")
    return input;
  if (Array.isArray(input)) return input.map(value);
  if (ArrayBuffer.isView(input) && !(input instanceof DataView)) return input as HdfValue;
  throw new Error("Unsupported HDF decoded value");
}

// Fixed strings and compounds expand to JS objects rather than typed arrays.
const MAX_DECODED_VALUES = 100000;
export function boundedDecodedValues(
  dtype: HdfDtype,
  elements: number,
  limit = MAX_DECODED_VALUES,
): number {
  const weight = (type: HdfDtype): number =>
    type.kind === "compound"
      ? 1 + (type.members ?? []).reduce((sum, member) => sum + weight(member.dtype), 0)
      : 1;
  const count = dtype.kind === "compound" || dtype.kind === "string" ? elements * weight(dtype) : 0;
  if (!Number.isSafeInteger(count) || count > limit)
    throw new Error("HDF read exceeds decoded value limit");
  return count;
}

/** Raw HDF reader, intentionally independent of the NetCDF geographic adapter. */
export class HdfReader {
  private closed = false;
  private constructor(
    private readonly file: H5File,
    private readonly release: () => void,
  ) {}

  static async open(bytes: ArrayBuffer): Promise<HdfReader> {
    if (bytes.byteLength > HDF_LIMITS.sourceBytes) throw new Error("HDF source exceeds byte limit");
    const runtime = await loadH5wasm();
    const path = `/geolibre-hdf-${crypto.randomUUID()}.h5`;
    runtime.FS.writeFile(path, new Uint8Array(bytes));
    let file: H5File | undefined;
    const release = () => {
      try {
        file?.close();
      } finally {
        runtime.FS.unlink(path);
      }
    };
    try {
      file = new runtime.File(path, "r");
      file.keys();
      return new HdfReader(file, release);
    } catch (error) {
      try {
        release();
      } catch {
        /* preserve the open error */
      }
      throw error;
    }
  }

  private entity(path: string): Entity {
    if (this.closed) throw new Error("HDF session is closed");
    const normalized = hdfPath(path);
    const result = normalized === "/" ? this.file : this.file.get(normalized);
    if (!result || typeof result !== "object") throw new Error(`HDF path not found: ${normalized}`);
    return result as Entity;
  }

  describe(path: string): HdfNode {
    path = hdfPath(path);
    const entity = this.entity(path);
    if (entity.keys) return { path, kind: "group" };
    if (!entity.metadata) throw new Error("Unsupported HDF object");
    return {
      path,
      kind: "dataset",
      shape: [...(entity.shape ?? entity.metadata.shape ?? [])],
      dtype: hdfDtype(entity.metadata),
    };
  }

  listChildren(path = "/"): HdfNode[] {
    path = hdfPath(path);
    const group = this.entity(path);
    if (!group.keys) throw new Error("HDF path is not a group");
    const keys = group.keys();
    if (keys.length > HDF_LIMITS.entries) throw new Error("HDF group exceeds entry limit");
    // One level only: never recurse through cyclic hard/soft links.
    return keys.map((key) => this.describe(`${path}/${key}`));
  }

  readAttributes(path: string): Record<string, HdfValue> {
    const attrs = this.entity(path).attrs ?? {};
    const keys = Object.keys(attrs);
    if (keys.length > HDF_LIMITS.entries) throw new Error("HDF attributes exceed entry limit");
    const output: Record<string, HdfValue> = Object.create(null);
    let remaining = HDF_LIMITS.attributeBytes;
    let decodedRemaining = MAX_DECODED_VALUES;
    // Validate the entire request before decoding any attribute values.
    for (const key of keys) {
      const attr = attrs[key];
      const dtype = hdfDtype(attr.metadata);
      if (dtype.kind === "unsupported") throw new Error(`Unsupported HDF attribute type: ${key}`);
      const elements = boundedElements(attr.shape ?? [], dtype.bytes, remaining);
      remaining -= elements * dtype.bytes;
      decodedRemaining -= boundedDecodedValues(dtype, elements, decodedRemaining);
    }
    for (const key of keys) output[key] = value(attrs[key].value);
    return output;
  }

  readDataset(path: string, selection: HdfSelection): HdfReadResult {
    const entity = this.entity(path);
    const node = this.describe(path);
    if (node.kind !== "dataset" || !node.dtype || !node.shape || !entity.slice)
      throw new Error("HDF path is not a dataset");
    const { dtype, shape } = node;
    if (dtype.kind === "unsupported") throw new Error("Unsupported HDF dataset type");
    if (
      !selection ||
      !Array.isArray(selection.start) ||
      !Array.isArray(selection.count) ||
      selection.start.length !== shape.length ||
      selection.count.length !== shape.length
    )
      throw new Error("HDF selection rank mismatch");
    const ranges: [number, number][] = shape.map((length, i) => {
      const start = selection.start[i],
        count = selection.count[i];
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        start < 0 ||
        count < 0 ||
        start > length ||
        count > length - start
      )
        throw new Error("HDF selection outside dataset");
      return [start, start + count];
    });
    const elements = boundedElements(selection.count, dtype.bytes, HDF_LIMITS.readBytes);
    boundedDecodedValues(dtype, elements);
    // H5Dread expands an entire compressed chunk even for a tiny hyperslab.
    const chunks = entity.metadata?.chunks;
    if (elements && chunks) {
      if (chunks.length !== shape.length || chunks.some((n) => n <= 0))
        throw new Error("Invalid HDF chunk shape");
      try {
        boundedElements(chunks, dtype.bytes, HDF_LIMITS.readBytes);
      } catch {
        throw new Error("HDF dataset chunk exceeds decode byte limit");
      }
    }
    const values = elements === 0 ? [] : value(shape.length ? entity.slice(ranges) : entity.value);
    return { shape: [...selection.count], dtype, values };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }
}
