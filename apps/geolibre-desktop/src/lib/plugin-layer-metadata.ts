import { useAppStore } from "@geolibre/core";
import type { JsonValue } from "@geolibre/plugins";

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

function namespaceValid(namespace: string): boolean {
  return (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    namespace.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace) &&
    !forbidden.has(namespace)
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone only JSON data, without invoking getters or user-provided toJSON. */
function copyJson(input: unknown): JsonValue {
  let bytes = 0,
    nodes = 0;
  const ancestors = new WeakSet<object>();
  function charge(amount: number): void {
    bytes += amount;
    if (bytes > MAX_BYTES) throw new Error("Layer user metadata exceeds byte limit");
  }
  function stringBytes(value: string): void {
    if (value.length > MAX_BYTES) throw new Error("Layer user metadata string exceeds byte limit");
    charge(encoder.encode(JSON.stringify(value)).length);
  }
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      throw new Error("Layer user metadata exceeds structure limits");
    if (value === null) {
      charge(4);
      return null;
    }
    if (typeof value === "boolean") {
      charge(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === "string") {
      stringBytes(value);
      return value;
    }
    if ((!Array.isArray(value) && !plainObject(value)) || typeof value !== "object")
      throw new Error("Layer user metadata must contain only JSON data");
    if (ancestors.has(value)) throw new Error("Layer user metadata contains a cycle");
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error("Symbol properties are not JSON data");
    charge(2);
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES || Object.keys(descriptors).length !== value.length + 1)
        throw new Error("Only dense JSON arrays are supported");
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw new Error("Array accessors and holes are not JSON data");
        if (index) charge(1);
        result.push(visit(descriptor.value, depth + 1));
      }
      ancestors.delete(value);
      return result;
    }
    const result: Record<string, JsonValue> = {};
    let index = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (forbidden.has(key) || !descriptor.enumerable || !("value" in descriptor))
        throw new Error("Unsafe metadata property");
      if (index++) charge(1);
      stringBytes(key);
      charge(1);
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  }
  return visit(input, 0);
}

/** Namespaced portable metadata; cannot overwrite core layer metadata keys. */
export function createPluginLayerMetadata() {
  return {
    getLayerUserMetadata(layerId: string, namespace: string): JsonValue | undefined {
      if (!namespaceValid(namespace)) return undefined;
      const user = useAppStore.getState().layers.find((layer) => layer.id === layerId)
        ?.metadata.user;
      if (!plainObject(user)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(user, namespace);
      if (!descriptor || !("value" in descriptor)) return undefined;
      try {
        return copyJson(descriptor.value);
      } catch {
        return undefined;
      }
    },
    setLayerUserMetadata(layerId: string, namespace: string, value: JsonValue): boolean {
      if (!namespaceValid(namespace)) return false;
      const state = useAppStore.getState();
      const layer = state.layers.find((item) => item.id === layerId);
      if (!layer || (layer.metadata.user !== undefined && !plainObject(layer.metadata.user)))
        return false;
      let copy: JsonValue;
      try {
        copy = copyJson(value);
      } catch {
        return false;
      }
      state.updateLayer(layerId, {
        metadata: {
          ...layer.metadata,
          user: {
            ...(layer.metadata.user as Record<string, unknown> | undefined),
            [namespace]: copy,
          },
        },
      });
      return true;
    },
  };
}
