export function retiredSecretaryError() {
  return Object.assign(
    new Error(
      "Native secretary review example is retired; preserve old state and use bot-owned approval.",
    ),
    { code: "unsupported" },
  );
}

/** Terminal compatibility entry: never inspect settings, replay or send. */
export function createReferenceSecretary() {
  throw retiredSecretaryError();
}
