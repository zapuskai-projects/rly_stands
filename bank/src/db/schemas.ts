const SCHEMA_NAME = /^[A-Za-z0-9_]{1,63}$/;

export const BUSINESS_SCHEMA = 'public';
export const INTERNAL_SCHEMA = 'kit_internal';

export interface BankSchemas {
  business: string;
  internal: string;
}

export function searchPathOptions(schemas: BankSchemas = { business: BUSINESS_SCHEMA, internal: INTERNAL_SCHEMA }): string {
  return `-c search_path=${schemas.business},${schemas.internal}`;
}

export function parseSearchPath(value: string): BankSchemas {
  const parts = value.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
  const [business, internal] = parts;
  if (parts.length !== 2 || !business || !internal || !SCHEMA_NAME.test(business) || !SCHEMA_NAME.test(internal)) {
    throw new Error(`Подключение к базе банка должно идти с search_path из двух схем (бизнес, служебная), сейчас: ${value}`);
  }
  return { business, internal };
}
