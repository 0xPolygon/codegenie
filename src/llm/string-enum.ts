import { Type, type TUnsafe } from "typebox";

/**
 * `{ type: "string", enum: [...] }` typed for TypeBox's `Static`. pi-ai's
 * `StringEnum` emits the same JSON but types it for pi-schema since 1.5.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default })
  });
}
