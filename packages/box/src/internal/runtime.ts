import type { BoxRuntime } from "../index.ts";

const builtInBoxRuntime: symbol = Symbol.for("vitehub.box.internal-runtime");

function isOrdinaryObjectPrototype(value: object): boolean {
  if (Object.getPrototypeOf(value) !== null || !Object.hasOwn(value, "constructor")) return false;
  const constructor = (value as { constructor: unknown }).constructor;
  return typeof constructor === "function"
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

export function isBuiltInBoxRuntime(runtime: BoxRuntime): boolean {
  return Object.getOwnPropertyDescriptor(runtime, builtInBoxRuntime)?.value === true;
}

export function hasDeclaredBoxRuntimeMember(value: object, key: PropertyKey): boolean {
  if (Object.hasOwn(value, key)) return true;
  let prototype = Object.getPrototypeOf(value);
  while (prototype && prototype !== Object.prototype) {
    if (isOrdinaryObjectPrototype(prototype)) return false;
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      return typeof constructor === "function"
        && constructor.prototype === prototype
        && /^class\b/.test(Function.prototype.toString.call(constructor));
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

export function markBuiltInBoxRuntime(runtime: BoxRuntime): BoxRuntime {
  Object.defineProperty(runtime, builtInBoxRuntime, { value: true });
  return runtime;
}
