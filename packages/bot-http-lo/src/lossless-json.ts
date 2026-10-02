type JsonPrimitiveContext = { readonly source: string };
type LosslessJsonParse = (
  text: string,
  reviver: (
    this: unknown,
    key: string,
    value: unknown,
    context?: JsonPrimitiveContext,
  ) => unknown,
) => unknown;

const losslessJsonParse = JSON.parse as LosslessJsonParse;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/;

export function parseLosslessJson(text: string): unknown {
  return losslessJsonParse(text, (_key, value, context) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    context &&
    integerPattern.test(context.source)
      ? context.source
      : value,
  );
}
