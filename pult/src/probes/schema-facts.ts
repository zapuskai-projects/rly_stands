import { asArray, asRecord } from './http';
import { refName, resolveRef } from './document';

export type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  format: string | null;
  enum: unknown[];
  minimum: number | null;
  maximum: number | null;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  minItems: number | null;
  maxItems: number | null;
  additionalProperties: boolean | null;
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function extraPropertiesAllowed(schema: Record<string, unknown>): boolean | null {
  const declared = schema.additionalProperties;
  if (declared === undefined) return null;
  return declared !== false;
}

function typeOf(node: unknown, schema: Record<string, unknown>): string {
  const reference = refName(node);
  if (reference) return reference;
  const declared = schema.type;
  if (Array.isArray(declared)) return declared.map(String).join('|');
  if (typeof declared === 'string') return declared;
  if (schema.properties) return 'object';
  if (schema.enum) return 'string';
  return 'any';
}

function mergedSchema(doc: Record<string, unknown>, schema: Record<string, unknown>) {
  const properties: Record<string, unknown> = { ...asRecord(schema.properties) };
  const required = new Set(asArray(schema.required).map(String));
  for (const part of asArray(schema.allOf)) {
    const resolved = asRecord(resolveRef(doc, part));
    Object.assign(properties, asRecord(resolved.properties));
    for (const name of asArray(resolved.required)) required.add(String(name));
  }
  return { properties, required };
}

export function schemaFields(
  doc: Record<string, unknown>,
  schemaNode: unknown,
  prefix = '',
  depth = 0,
): SchemaField[] {
  const schema = asRecord(resolveRef(doc, schemaNode));
  const { properties, required } = mergedSchema(doc, schema);
  const out: SchemaField[] = [];
  for (const [name, node] of Object.entries(properties)) {
    const property = asRecord(resolveRef(doc, node));
    const full = `${prefix}${name}`;
    out.push({
      name: full,
      type: typeOf(node, property),
      required: required.has(name),
      format: typeof property.format === 'string' ? property.format : null,
      enum: asArray(property.enum),
      minimum: numberOrNull(property.minimum),
      maximum: numberOrNull(property.maximum),
      minLength: numberOrNull(property.minLength),
      maxLength: numberOrNull(property.maxLength),
      pattern: typeof property.pattern === 'string' ? property.pattern : null,
      minItems: numberOrNull(property.minItems),
      maxItems: numberOrNull(property.maxItems),
      additionalProperties: extraPropertiesAllowed(property),
    });
    if (depth < 4 && (property.properties || property.allOf) && !refName(node)) {
      out.push(...schemaFields(doc, property, `${full}.`, depth + 1));
    }
    if (depth < 4 && property.type === 'array' && property.items) {
      const items = asRecord(resolveRef(doc, property.items));
      if (items.properties || items.allOf) out.push(...schemaFields(doc, items, `${full}[].`, depth + 1));
    }
  }
  return out;
}

export function schemaTypeName(doc: Record<string, unknown>, node: unknown): string {
  return typeOf(node, asRecord(resolveRef(doc, node)));
}

export function schemaSummary(doc: Record<string, unknown>, schemaNode: unknown) {
  const schema = asRecord(resolveRef(doc, schemaNode));
  const { required } = mergedSchema(doc, schema);
  return {
    type: schemaTypeName(doc, schemaNode),
    required: [...required],
    fields: schemaFields(doc, schemaNode),
  };
}
