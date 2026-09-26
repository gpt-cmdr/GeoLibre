/// <reference lib="webworker" />
import { HDF_LIMITS, type HdfSelection } from "@geolibre/plugins/hdf-types";
import { HdfReader } from "@geolibre/plugins/hdf-reader";

export type HdfRequest = { id: number } & (
  | { type: "open"; blob: Blob }
  | { type: "describe" | "listChildren" | "readAttributes"; path: string }
  | { type: "readDataset"; path: string; selection: HdfSelection }
);
export type HdfResponse =
  | { ready: true }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
let reader: HdfReader | undefined;
let opening = false;

async function handle(request: HdfRequest): Promise<unknown> {
  if (request.type === "open") {
    if (reader || opening) throw new Error("HDF worker already opened");
    if (!(request.blob instanceof Blob) || request.blob.size > HDF_LIMITS.sourceBytes)
      throw new Error("Invalid or oversized HDF source");
    opening = true;
    try {
      reader = await HdfReader.open(await request.blob.arrayBuffer());
    } finally {
      opening = false;
    }
    return null;
  }
  if (!reader) throw new Error("HDF file is not open");
  if (request.type === "readDataset") return reader.readDataset(request.path, request.selection);
  return reader[request.type](request.path);
}

function buffers(value: unknown, output = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) output.add(value.buffer);
  else if (Array.isArray(value)) for (const item of value) buffers(item, output);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) buffers(item, output);
  return output;
}
self.onmessage = async (event: MessageEvent<HdfRequest>) => {
  const request = event.data;
  try {
    const result = await handle(request);
    self.postMessage({ id: request.id, ok: true, result } satisfies HdfResponse, {
      transfer: [...buffers(result)],
    });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies HdfResponse);
  }
};
self.postMessage({ ready: true } satisfies HdfResponse);
