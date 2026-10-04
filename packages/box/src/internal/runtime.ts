import type { BoxRuntime } from "../index.ts";

const builtInBoxRuntime: symbol = Symbol.for("vitehub.box.internal-runtime");

export function isBuiltInBoxRuntime(runtime: BoxRuntime): boolean {
  return Object.hasOwn(runtime, builtInBoxRuntime) && runtime[builtInBoxRuntime] === true;
}

export function hasDeclaredBoxRuntimeMember(value: object, key: PropertyKey): boolean {
  if (Object.hasOwn(value, key)) return true;
  let prototype = Object.getPrototypeOf(value);
  while (prototype && prototype !== Object.prototype) {
    if (Object.hasOwn(prototype, key)) {
      return Object.hasOwn(prototype, "constructor") && prototype.constructor !== Object;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

export function markBuiltInBoxRuntime(runtime: BoxRuntime): BoxRuntime {
  Object.defineProperty(runtime, builtInBoxRuntime, { value: true });
  return runtime;
}
