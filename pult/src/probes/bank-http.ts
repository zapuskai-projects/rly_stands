import { publicBase, BANK_MODULE } from './bank-api';
import { ProbeError } from './errors';
import { asArray, asRecord, failure, http, str } from './http';
import { executor, type ExecutorTable } from './types';

const CALL_TIMEOUT_MS = 30_000;
const CODE = /\b(\d{6})\b/;

type HttpParams = {
  asPhone: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export async function loginAs(phone: string): Promise<string> {
  const base = publicBase();
  const challenge = await http(BANK_MODULE, `${base}/api/v1/auth/login`, {
    method: 'POST',
    json: { phone },
    timeoutMs: CALL_TIMEOUT_MS,
  });
  if (!challenge.ok) throw failure(BANK_MODULE, 'вход клиента', challenge);
  const sms = await http(BANK_MODULE, `${base}/api/v1/sandbox/sms?phone=${encodeURIComponent(phone)}&limit=1`, {
    timeoutMs: CALL_TIMEOUT_MS,
  });
  if (!sms.ok) throw failure(BANK_MODULE, 'чтение СМС с кодом входа', sms);
  const code = CODE.exec(str(asRecord(asArray(asRecord(sms.json).items)[0]).text))?.[1];
  if (!code) throw new ProbeError('ЗапускБанк: СМС с кодом входа не пришло');
  const token = await http(BANK_MODULE, `${base}/api/v1/auth/verify`, {
    method: 'POST',
    json: { challengeId: str(asRecord(challenge.json).challengeId), code },
    timeoutMs: CALL_TIMEOUT_MS,
  });
  if (!token.ok) throw failure(BANK_MODULE, 'подтверждение кода входа', token);
  return str(asRecord(token.json).accessToken);
}

export const BANK_HTTP_EXECUTORS: ExecutorTable = {
  'bank.http': executor<HttpParams>(async (params, ctx) => {
    const token = await loginAs(params.asPhone);
    const result = await http(BANK_MODULE, `${publicBase()}${params.path}`, {
      method: params.method,
      json: params.body,
      headers: { ...params.headers, Authorization: `Bearer ${token}`, 'X-Attempt-Label': ctx.label },
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const body = asRecord(result.json);
    return {
      status: result.status,
      code: str(body.code),
      operationId: str(body.id),
      number: str(body.number),
      replayed: result.headers['idempotent-replayed'] === 'true',
    };
  }),
};
