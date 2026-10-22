import { z } from 'zod';

export interface SbpRequest {
  operationId: string;
  operationNumber: string;
  amount: number;
  currency: 'RUB';
  recipientPhone: string;
  recipientBankCode: string;
  senderBank: string;
  requestId: string;
}

export type SbpAnswer =
  | { kind: 'ACCEPTED'; reference: string }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'UNAVAILABLE'; reason: string }
  | { kind: 'TIMEOUT' };

export type RecipientNameLookup = (phone: string, bankCode: string) => Promise<string | null>;

export interface SbpGateway {
  send(request: SbpRequest): Promise<SbpAnswer>;
  lookup: RecipientNameLookup;
}

const LOOKUP_TIMEOUT_MS = 2000;

const lookupSchema = z.object({ found: z.boolean(), displayName: z.string().nullable() });

const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ACCEPTED'), reference: z.string() }),
  z.object({ status: z.literal('REJECTED'), reason: z.string() }),
]);

export class HttpSbpGateway implements SbpGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  lookup: RecipientNameLookup = async (phone, bankCode) => {
    try {
      const query = new URLSearchParams({ phone, bankCode });
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/sbp/v1/lookup?${query.toString()}`, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const parsed = lookupSchema.safeParse(await response.json());
      return parsed.success && parsed.data.found ? parsed.data.displayName : null;
    } catch {
      return null;
    }
  };

  async send(request: SbpRequest): Promise<SbpAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/sbp/v1/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': request.requestId },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (response.status >= 500) return { kind: 'UNAVAILABLE', reason: `СБП ответила кодом ${response.status}` };
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: 'UNAVAILABLE', reason: 'СБП вернула ответ неизвестного формата' };
      return parsed.data.status === 'ACCEPTED'
        ? { kind: 'ACCEPTED', reference: parsed.data.reference }
        : { kind: 'REJECTED', reason: parsed.data.reason };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'TIMEOUT' };
      return { kind: 'UNAVAILABLE', reason: error instanceof Error ? error.message : 'СБП недоступна' };
    } finally {
      clearTimeout(timer);
    }
  }
}
