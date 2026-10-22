const UNTRUSTED_CERT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const CERT_DATE_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);

const MAX_CAUSE_DEPTH = 5;

function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hostOf(platformUrl: string): string {
  try {
    return new URL(platformUrl).host;
  } catch {
    return platformUrl;
  }
}

export function describeNetworkError(error: unknown, platformUrl: string): string {
  const chain = causeChain(error);
  const codes = chain.map(codeOf);
  const host = hostOf(platformUrl);
  if (codes.some((code) => code !== undefined && UNTRUSTED_CERT_CODES.has(code))) {
    return (
      `пульт не доверяет сертификату ${host}. Похоже, соединение проверяет антивирус или сеть на работе ` +
      `(браузер при этом может открывать сайт). Добавьте ${host} в исключения антивируса ` +
      'или подключитесь из другой сети.'
    );
  }
  if (codes.some((code) => code !== undefined && CERT_DATE_CODES.has(code))) {
    return `сертификат ${host} не прошёл проверку по дате. Проверьте дату и время на компьютере; если они верные — напишите куратору.`;
  }
  const deepest = chain.at(-1);
  return deepest?.message || 'нет ответа';
}
