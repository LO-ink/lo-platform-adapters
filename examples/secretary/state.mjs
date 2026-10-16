import { retiredSecretaryError } from "./reference.mjs";

/** Old files and locks are retained without opening or rewriting them. */
export async function openSecretaryState() {
  throw retiredSecretaryError();
}
