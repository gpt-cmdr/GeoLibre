// h5wasm's structural types, kept minimal so this module does not need the
// package at type-check time in consumers. The real shapes come from the
// dynamic import in {@link loadH5wasm}.
export interface H5Metadata {
  type: number; // HDF5 type class: 0 = integer, 1 = float
  size: number; // bytes per element
  signed: boolean;
  shape: number[] | null;
  vlen?: boolean;
  chunks?: number[] | null;
  compound_type?: { members: (H5Metadata & { name: string; offset: number })[] };
}
export interface H5Dataset {
  metadata: H5Metadata;
  shape: number[] | null;
  attrs: Record<string, { value: unknown }>;
  value: unknown;
  slice(ranges: Array<[] | [number] | [number, number]>): unknown;
  get_dimension_labels(): Array<string | null>;
}
export interface H5Group {
  keys(): string[];
  get(path: string): unknown;
  attrs?: Record<string, { metadata: H5Metadata; shape: number[] | null; value: unknown }>;
}
export interface H5File extends H5Group {
  close(): void;
}
export interface H5FS {
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}
/** The h5wasm surface we use: the File constructor plus the ready filesystem. */
export interface H5wasmModule {
  FS: H5FS;
  File: new (name: string, mode: string) => H5File;
}
/** Shape of the dynamically imported `h5wasm` module. */
interface H5wasmNamespace {
  default?: {
    ready: Promise<{ FS: H5FS }>;
    File: new (name: string, mode: string) => H5File;
  };
  ready?: Promise<{ FS: H5FS }>;
  File?: new (name: string, mode: string) => H5File;
}

let modulePromise: Promise<H5wasmModule> | null = null;

/**
 * Lazily load and initialize h5wasm. The (~5.6 MB) single-file WASM module is
 * only fetched the first time a user opens a local HDF5/NetCDF-4 file, keeping
 * it out of the main bundle.
 *
 * @returns The initialized h5wasm module namespace.
 */
export async function loadH5wasm(): Promise<H5wasmModule> {
  modulePromise ??= (async () => {
    const ns = (await import("h5wasm")) as unknown as H5wasmNamespace;
    const api = ns.default ?? ns;
    // `ready` resolves to the emscripten Module, whose `.FS` is the in-memory
    // filesystem. The top-level `FS` export is null until then, so read it from
    // the resolved module rather than the namespace.
    const ready = api.ready ?? ns.ready;
    const File = api.File ?? ns.File;
    if (!ready || !File) {
      throw new Error("h5wasm did not expose the expected File/ready API.");
    }
    const module = await ready;
    return { FS: module.FS, File };
  })();
  try {
    return await modulePromise;
  } catch (err) {
    // A transient failure (network/cache hiccup) leaves a rejected promise
    // cached; clear it so the next open retries instead of failing forever.
    modulePromise = null;
    throw err;
  }
}
