/** Version 1, raw read-only HDF5. The host performs no CF or CRS interpretation. */
export interface HdfDtype {
  kind: "integer" | "float" | "string" | "compound" | "unsupported";
  bytes: number;
  signed?: boolean;
  members?: { name: string; dtype: HdfDtype }[];
}
export type HdfValue =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | string
  | number
  | bigint
  | HdfValue[];
export interface HdfNode {
  path: string;
  kind: "group" | "dataset";
  shape?: number[];
  dtype?: HdfDtype;
}
export interface HdfReadResult {
  shape: number[];
  dtype: HdfDtype;
  values: HdfValue;
}
export interface HdfReadOptions {
  signal?: AbortSignal;
}
export interface HdfSelection {
  start: number[];
  count: number[];
}
export const HDF_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024 * 1024,
  readBytes: 16 * 1024 * 1024,
  attributeBytes: 1024 * 1024,
  entries: 10000,
});
export interface HdfSession {
  readonly version: 1;
  readonly limits: typeof HDF_LIMITS;
  listChildren(path?: string, options?: HdfReadOptions): Promise<HdfNode[]>;
  describe(path: string, options?: HdfReadOptions): Promise<HdfNode>;
  readAttributes(path: string, options?: HdfReadOptions): Promise<Record<string, HdfValue>>;
  readDataset(
    path: string,
    selection: HdfSelection,
    options?: HdfReadOptions,
  ): Promise<HdfReadResult>;
  /** Idempotent. Closing rejects outstanding and future requests. */
  close(): void;
}
