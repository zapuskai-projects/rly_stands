import { LAVKA_PARTNER_KEY } from '../partners/partner-key';
import { LAVKA_PARTNER } from '../partners/partners.repository';
import { KIT_TEST_SECRET, pick, startHarness, type ApiResponse, type Harness } from './harness';
import { accountOf, NOON_MOSCOW, PHONES, useRelease } from './scenarios';

export const PARTNER_HEADERS = { 'X-Partner-Key': LAVKA_PARTNER_KEY };

export function partnerApi(h: Harness, method: string, path: string, body?: unknown, headers: Record<string, string> = PARTNER_HEADERS): Promise<ApiResponse> {
  return h.api(null, method, path, body, headers);
}

export interface QrOrder {
  orderId: string;
  amount: number;
  description?: string;
  ttlSeconds?: number;
}

export function issueQr(h: Harness, order: QrOrder): Promise<ApiResponse> {
  return partnerApi(h, 'POST', '/partner/v1/qr', { description: 'Заказ из лавки', ...order });
}

export async function issuedQr(h: Harness, order: QrOrder): Promise<{ qrId: string; payload: string }> {
  const created = await issueQr(h, order);
  if (created.status !== 201) throw new Error(`QR не выставлен: ${JSON.stringify(created.body)}`);
  return { qrId: String(pick(created.body, 'qrId')), payload: String(pick(created.body, 'payload')) };
}

export function readQr(h: Harness, qrId: string): Promise<ApiResponse> {
  return partnerApi(h, 'GET', `/partner/v1/qr/${qrId}`);
}

export function payQr(h: Harness, token: string, key: string, payload: string, accountId: string, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return h.api(token, 'POST', '/api/v1/qr-payments', { payload, accountId }, { 'Idempotency-Key': key, ...headers });
}

export async function balanceOfClient(h: Harness, number: string): Promise<{ balance: bigint; accountNumber: string }> {
  const result = await h.pool.query<{ balance_kop: bigint; number: string }>(
    `SELECT a.balance_kop, a.number FROM accounts a JOIN clients c ON c.id = a.client_id WHERE c.number = $1 AND a.is_primary`,
    [number],
  );
  const row = result.rows[0] as { balance_kop: bigint; number: string };
  return { balance: row.balance_kop, accountNumber: row.number };
}

export async function incomeBalance(h: Harness): Promise<bigint> {
  const result = await h.pool.query<{ balance_kop: bigint }>("SELECT balance_kop FROM accounts WHERE kind = 'INCOME'");
  return (result.rows[0] as { balance_kop: bigint }).balance_kop;
}

export const SHOP_CLIENT_NUMBER = LAVKA_PARTNER.ownerClientNumber;

export async function startOnRelease(release: '1.0' | '1.1' | '1.2', time = NOON_MOSCOW): Promise<Harness> {
  const h = await startHarness(process.env.TEST_DATABASE_URL as string, time, { kitSecret: KIT_TEST_SECRET });
  await useRelease(h, release);
  return h;
}

export function refundQr(h: Harness, qrId: string, amount: number, key: string, headers: Record<string, string> = {}): Promise<ApiResponse> {
  return partnerApi(h, 'POST', `/partner/v1/qr/${qrId}/refunds`, { amount }, { ...PARTNER_HEADERS, 'Idempotency-Key': key, ...headers });
}

export function putWebhook(h: Harness, url: string, secret: string): Promise<ApiResponse> {
  return partnerApi(h, 'PUT', '/partner/v1/webhook', { url, secret });
}

export function listDeliveries(h: Harness, query = ''): Promise<ApiResponse> {
  return partnerApi(h, 'GET', `/partner/v1/webhook/deliveries${query}`);
}

export interface PaidOrder {
  qrId: string;
  payload: string;
  operationId: string;
  token: string;
  accountId: string;
}

export async function payOrder(h: Harness, order: QrOrder, phone: string = PHONES.ANNA): Promise<PaidOrder> {
  const qr = await issuedQr(h, order);
  const token = await h.login(phone);
  const account = await accountOf(h, token);
  const paid = await payQr(h, token, `pay-${order.orderId}-key`, qr.payload, account.id);
  if (paid.status !== 201) throw new Error(`оплата не создана: ${JSON.stringify(paid.body)}`);
  await h.drain();
  return { ...qr, operationId: String(pick(paid.body, 'id')), token, accountId: account.id };
}

export async function setWebhookDirect(h: Harness, url: string, secret: string): Promise<void> {
  await h.pool.query('UPDATE partners SET webhook_url = $1, webhook_secret = $2', [url, secret]);
}
