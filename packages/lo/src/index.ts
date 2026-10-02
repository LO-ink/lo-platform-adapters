/** Native LO integration. Compatibility is installed through separate packages. */
export {
  createNativeAdapter,
  createNativeAdapter as createAdapter,
  createNativeAdapter as detectAdapter,
  type LoMiniAppNativePort,
  type LoNativeAdapter,
  type LoNativeGlobal,
  type LoNativeGlobal as LoGlobal,
  type LoNativeOperation,
} from "./native.js";
