import { getTopics } from '../events/topics';
import { pick, type Harness } from './harness';

export async function tick(h: Harness): Promise<void> {
  await h.autopay();
  await h.drain();
  await h.autopay();
  await h.drain();
}

export async function makeTemplate(h: Harness, token: string, body: Record<string, unknown>): Promise<string> {
  const created = await h.api(token, 'POST', '/api/v1/templates', body);
  if (created.status !== 201) throw new Error(`шаблон не создан: ${JSON.stringify(created.body)}`);
  return String(pick(created.body, 'id'));
}

export function makeAutopayment(h: Harness, token: string, body: Record<string, unknown>) {
  return h.api(token, 'POST', '/api/v1/autopayments', body);
}

export async function autopaymentOf(h: Harness, token: string, id: string): Promise<Record<string, unknown>> {
  const list = await h.api(token, 'GET', '/api/v1/autopayments');
  return (pick(list.body, 'items') as Record<string, unknown>[]).find((item) => item.id === id) as Record<string, unknown>;
}

export async function runsOf(h: Harness, token: string, id: string): Promise<Record<string, unknown>[]> {
  const response = await h.api(token, 'GET', `/api/v1/autopayments/${id}/runs`);
  return pick(response.body, 'items') as Record<string, unknown>[];
}

export function autopayEvents(h: Harness): { key: string | null; payload: Record<string, unknown>; headers: Record<string, string> }[] {
  return h.events
    .filter((event) => event.topic === getTopics().autopaymentsExecuted)
    .map((event) => ({ key: event.key, payload: event.payload as Record<string, unknown>, headers: event.headers }));
}

export async function notificationTexts(h: Harness, phone: string, kind: string): Promise<string[]> {
  const result = await h.pool.query<{ text: string }>('SELECT text FROM notifications WHERE phone = $1 AND kind = $2 ORDER BY id', [phone, kind]);
  return result.rows.map((row) => row.text);
}
