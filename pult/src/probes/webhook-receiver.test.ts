import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import { EXECUTORS } from './registry';
import { answerFor, signatureMatches, signatureOf, summarize } from './webhook-receiver';

const ctx = { workDir: '/tmp', label: 'k7f3qa' };
const run = (key: string, params: Record<string, unknown>) => EXECUTORS[key]!(params, ctx) as Promise<Record<string, unknown>>;

describe('подпись уведомления', () => {
  it('HMAC-SHA256 по точной строке тела, шестнадцатеричная, с префиксом sha256=', () => {
    const body = '{"event":"qr.paid","amount":123450}';
    assert.equal(signatureOf('my-shared-secret', body), `sha256=${createHmac('sha256', 'my-shared-secret').update(body).digest('hex')}`);
    assert.equal(signatureMatches('my-shared-secret', body, signatureOf('my-shared-secret', body)), true);
    assert.equal(signatureMatches('my-shared-secret', body, signatureOf('other', body)), false);
    assert.equal(signatureMatches('my-shared-secret', `${body} `, signatureOf('my-shared-secret', body)), false);
    assert.equal(signatureMatches('my-shared-secret', body, undefined), false);
  });

  it('ответы по порядку, последний повторяется', () => {
    assert.deepEqual([0, 1, 2, 5].map((n) => answerFor([500, 200], n)), [500, 200, 200, 200]);
    assert.deepEqual([answerFor([], 0), answerFor(undefined, 0), answerFor('200', 1), answerFor([700], 0)], [500, 500, 500, 500]);
  });

  it('сводка: неверная подпись не входит в принятые, один и тот же X-Event-Id у повторов', () => {
    const summary = summarize([
      { status: 401, signatureOk: false, eventId: 'x', event: '' },
      { status: 500, signatureOk: true, eventId: 'e1', event: 'qr.paid' },
      { status: 200, signatureOk: true, eventId: 'e1', event: 'qr.paid' },
    ]);
    assert.deepEqual(summary, { received: 3, accepted: 2, rejectedBySignature: 1, statuses: [401, 500, 200], sameEventId: true });
  });
});

describe('webhook.receiverStart и receiverStop', () => {
  const port = 29871;
  const send = async (body: string | Buffer, signature: string, headers: Record<string, string> = {}) =>
    (await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'X-Signature': signature, 'X-Event-Id': 'ev-1', ...headers } })).status;

  it('настоящий приёмник: 500 на первое уведомление, 200 на повтор, 401 на неверную подпись', async () => {
    const started = await run('webhook.receiverStart', { port, secret: 's3cret', responses: [500, 200] });
    try {
      assert.deepEqual([started.listening, started.host], [port, hostname()]);
      const body = '{"event":"qr.paid"}';
      assert.equal(await send(body, 'sha256=bad'), 401);
      assert.equal(await send(body, signatureOf('s3cret', body)), 500);
      assert.equal(await send(body, signatureOf('s3cret', body)), 200);
    } finally {
      const summary = await run('webhook.receiverStop', { port });
      assert.deepEqual(summary, { received: 3, accepted: 2, rejectedBySignature: 1, statuses: [401, 500, 200], sameEventId: true });
    }
    await assert.rejects(run('webhook.receiverStop', { port }), /не запущен/);
  });

  it('повторный запуск на занятом порту после упавшего эталона закрывает старый приёмник и начинает счёт заново', async () => {
    await run('webhook.receiverStart', { port, secret: 'old', responses: [500] });
    try {
      await run('webhook.receiverStart', { port, secret: 'new', responses: [200] });
      const body = '{"event":"qr.paid"}';
      assert.equal(await send(body, signatureOf('old', body)), 401);
      assert.equal(await send(body, signatureOf('new', body)), 200);
    } finally {
      const summary = await run('webhook.receiverStop', { port });
      assert.equal(summary.received, 2);
    }
  });

  it('подпись считается по сырым байтам: не-UTF-8 тело с верной подписью принимается', async () => {
    await run('webhook.receiverStart', { port, secret: 's3cret', responses: [200] });
    try {
      const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
      assert.equal(await send(raw, signatureOf('s3cret', raw)), 200);
    } finally {
      await run('webhook.receiverStop', { port });
    }
  });

  it('журнал приёмника ограничен: после двухсот записей новые не копятся, ответы идут по-прежнему', async () => {
    await run('webhook.receiverStart', { port, secret: 's3cret', responses: [200] });
    try {
      const body = '{"event":"qr.paid"}';
      for (let index = 0; index < 205; index += 1) assert.equal(await send(body, signatureOf('s3cret', body)), 200);
    } finally {
      const summary = await run('webhook.receiverStop', { port });
      assert.equal(summary.received, 200);
    }
  });

  it('слишком большое тело — 413 и в сводку как неверная подпись; без идентификатора события sameEventId ложно', async () => {
    await run('webhook.receiverStart', { port, secret: 's3cret', responses: [200] });
    try {
      const big = 'x'.repeat(70 * 1024);
      assert.equal(await send(big, signatureOf('s3cret', big)), 413);
      const body = '{"event":"qr.paid"}';
      assert.equal(await send(body, signatureOf('s3cret', body), { 'X-Event-Id': '' }), 200);
    } finally {
      const summary = await run('webhook.receiverStop', { port });
      assert.deepEqual([summary.received, summary.accepted, summary.sameEventId], [2, 1, false]);
    }
  });
});
