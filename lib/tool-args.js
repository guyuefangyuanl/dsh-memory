/** Validate the flat memory tool contract without a runtime dependency or coercion. */
export function validateToolArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    return 'memory arguments must be a JSON object, not a string, array, or null.'
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) return `${key} is required.`
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) return `Unknown parameter "${key}". Use the declared memory parameters.`
    const property = schema.properties[key]
    const valid = property.type === 'array'
      ? Array.isArray(value) && Array.from(value).every((item) => typeof item === property.items.type)
      : property.type === 'integer'
        ? Number.isSafeInteger(value)
        : typeof value === property.type
    if (!valid) return `${key} must be ${property.type === 'array' ? 'an array of strings' : `a ${property.type}`}; omit unused parameters instead of passing null.`
    if (property.enum && !property.enum.includes(value)) return `${key} must be one of: ${property.enum.join(', ')}.`
  }
  if (args.limit !== undefined && args.limit <= 0) return 'limit must be a positive safe integer.'
  return null
}
