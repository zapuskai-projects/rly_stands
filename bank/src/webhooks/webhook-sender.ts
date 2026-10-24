import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { classifyAddress, type AddressClass } from './address-guard';
import { WEBHOOK_TIMEOUT_MS } from './webhook-signature';

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type WebhookAnswer = { kind: 'RESPONSE'; status: number } | { kind: 'ERROR'; error: string };

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookAnswer>;

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SenderOptions {
  resolve?: AddressResolver;
  guard?: (address: string) => AddressClass | null;
}

const FORBIDDEN_ERROR: Record<AddressClass, string> = {
  LOOPBACK: 'WEBHOOK_URL_LOOPBACK',
  UNSPECIFIED: 'WEBHOOK_URL_LOOPBACK',
  LINK_LOCAL: 'WEBHOOK_URL_FORBIDDEN',
};

const resolveAll: AddressResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'TIMEOUT';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'NETWORK_ERROR';
}

async function addressesOf(hostname: string, resolve: AddressResolver): Promise<ResolvedAddress[]> {
  const version = isIP(hostname);
  if (version !== 0) return [{ address: hostname, family: version }];
  return resolve(hostname);
}

function post(url: URL, target: ResolvedAddress, request: WebhookRequest, signal: AbortSignal): Promise<WebhookAnswer> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const outgoing = client.request(
      url,
      {
        method: 'POST',
        headers: { ...request.headers, 'Content-Length': Buffer.byteLength(request.body) },
        signal,
        lookup: (_host, options, callback) => {
          if (options.all) (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, [target]);
          else callback(null, target.address, target.family);
        },
      },
      (response) => {
        response.on('error', () => undefined);
        response.resume();
        resolve({ kind: 'RESPONSE', status: response.statusCode ?? 0 });
      },
    );
    outgoing.on('error', (error) => resolve({ kind: 'ERROR', error: errorCode(error) }));
    outgoing.end(request.body);
  });
}

export function createHttpWebhookSender(timeoutMs = WEBHOOK_TIMEOUT_MS, options: SenderOptions = {}): WebhookSender {
  const resolve = options.resolve ?? resolveAll;
  const guard = options.guard ?? classifyAddress;
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { kind: 'ERROR', error: 'WEBHOOK_URL_INVALID' };
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    try {
      addresses = await addressesOf(hostname, resolve);
    } catch (error) {
      return { kind: 'ERROR', error: errorCode(error) };
    }
    const target = addresses[0];
    if (!target) return { kind: 'ERROR', error: 'ENOTFOUND' };
    for (const candidate of addresses) {
      const kind = guard(candidate.address);
      if (kind) return { kind: 'ERROR', error: FORBIDDEN_ERROR[kind] };
    }
    return post(url, target, request, AbortSignal.timeout(timeoutMs));
  };
}
