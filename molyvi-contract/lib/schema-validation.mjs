// Small, explicit validator for this project's preparation schema, not a general
// JSON Schema implementation. Reject unsupported assertions instead of ignoring them.
const assertions = new Set(['$ref', 'type', 'const', 'enum', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'allOf', 'anyOf',
  'oneOf', 'if', 'then', 'else']);
const annotations = new Set(['$schema', '$id', '$defs', 'title', 'description',
  '$comment', 'default', 'examples']);
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
const matchesType = (value, type) => ({
  null: () => value === null,
  object: () => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: () => Array.isArray(value),
  integer: () => Number.isSafeInteger(value),
  number: () => typeof value === 'number' && Number.isFinite(value),
  string: () => typeof value === 'string',
  boolean: () => typeof value === 'boolean',
}[type]?.() ?? false);

function assertSupported(schema) {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid schema node');
  for (const key of Object.keys(schema)) {
    if (!assertions.has(key) && !annotations.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  for (const group of ['properties', '$defs']) for (const child of Object.values(schema[group] ?? {})) assertSupported(child);
  for (const group of ['allOf', 'anyOf', 'oneOf']) for (const child of schema[group] ?? []) assertSupported(child);
  for (const key of ['items', 'additionalProperties', 'if', 'then', 'else']) if (schema[key] !== undefined) assertSupported(schema[key]);
}

export function validateSchema(value, schema) {
  assertSupported(schema);
  function visit(item, rule, at, depth = 0) {
    if (depth > 100) throw new Error('Schema recursion limit');
    if (rule === true) return [];
    if (rule === false) return [`${at}: not allowed`];
    const errors = [];
    const fail = message => errors.push(`${at}: ${message}`);
    const check = (child, childRule, childAt = at) => visit(child, childRule, childAt, depth + 1);
    if (rule.$ref) {
      if (!rule.$ref.startsWith('#/')) throw new Error('Only local schema references are supported');
      const resolved = rule.$ref.slice(2).split('/').reduce((current, part) => current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
      if (resolved === undefined) throw new Error(`Unresolved schema reference: ${rule.$ref}`);
      errors.push(...check(item, resolved));
    }
    if (rule.type && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some(type => matchesType(item, type))) {
      fail(`expected type ${JSON.stringify(rule.type)}`);
      return errors;
    }
    if (Object.hasOwn(rule, 'const') && !equal(item, rule.const)) fail('constant mismatch');
    if (rule.enum && !rule.enum.some(option => equal(item, option))) fail('not an allowed value');
    if (typeof item === 'string') {
      const length = [...item].length;
      if (rule.minLength !== undefined && length < rule.minLength) fail('too short');
      if (rule.maxLength !== undefined && length > rule.maxLength) fail('too long');
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(item)) fail('pattern mismatch');
    }
    if (typeof item === 'number') {
      if (rule.minimum !== undefined && item < rule.minimum) fail('below minimum');
      if (rule.maximum !== undefined && item > rule.maximum) fail('above maximum');
    }
    if (Array.isArray(item)) {
      if (rule.minItems !== undefined && item.length < rule.minItems) fail('too few items');
      if (rule.maxItems !== undefined && item.length > rule.maxItems) fail('too many items');
      if (rule.uniqueItems && item.some((entry, index) => item.slice(0, index).some(previous => equal(entry, previous)))) fail('duplicate items');
      if (rule.items !== undefined) item.forEach((entry, index) => errors.push(...check(entry, rule.items, `${at}[${index}]`)));
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of rule.required ?? []) if (!Object.hasOwn(item, key)) fail(`missing ${key}`);
      for (const key of Object.keys(item)) {
        if (Object.hasOwn(rule.properties ?? {}, key)) errors.push(...check(item[key], rule.properties[key], `${at}.${key}`));
        else if (rule.additionalProperties !== undefined) errors.push(...check(item[key], rule.additionalProperties, `${at}.${key}`));
      }
    }
    for (const child of rule.allOf ?? []) errors.push(...check(item, child));
    if (rule.anyOf && !rule.anyOf.some(child => check(item, child).length === 0)) fail('no anyOf branch matched');
    if (rule.oneOf && rule.oneOf.filter(child => check(item, child).length === 0).length !== 1) fail('exactly one oneOf branch must match');
    if (rule.if) {
      const branch = check(item, rule.if).length === 0 ? rule.then : rule.else;
      if (branch !== undefined) errors.push(...check(item, branch));
    }
    return errors;
  }
  return visit(value, schema, '$');
}
