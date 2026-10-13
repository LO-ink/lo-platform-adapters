import { retiredSecretaryError } from "./reference.mjs";

console.error(retiredSecretaryError().message);
process.exitCode = 1;
