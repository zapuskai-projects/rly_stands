import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { EXECUTORS } from './registry';

type Call = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
};

let server: Server;
let calls: Call[] = [];
let smsText = 'Код входа в ЗапускБанк: 482913';
let smsBefore: string[] = [];
let smsAfter: string[] = [];

function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : null));
  });
}

before(async () => {
  server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = request.url ?? '';
    calls.push({ method: request.method ?? '', url, headers: request.headers, body });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify(payload));
    };
    if (url === '/api/v1/auth/login') return send(200, { challengeId: 'ch-1', expiresInSec: 300 });
    if (url.startsWith('/api/v1/sandbox/sms')) return send(200, { items: [...smsBefore, smsText, ...smsAfter].map((text) => ({ text })) });
    if (url === '/api/v1/auth/verify') {
      return body?.code === '482913' ? send(200, { accessToken: 'token-1' }) : send(401, { code: 'INVALID_CODE' });
    }
    if (url.startsWith('/partner/v1/')) {
      if (request.headers['x-partner-key'] !== 'zbk_test_lavka_7f3a91c4e2d85b60a1c9') return send(401, { code: 'PARTNER_KEY_INVALID' });
      if (url === '/partner/v1/qr') return send(201, { qrId: 'qr-1', payload: 'zbqr://pay?id=qr-1', status: 'CREATED' });
      if (url === '/partner/v1/qr/qr-1/refunds') return send(201, { refundId: 'rf-1', qrStatus: 'PARTIALLY_REFUNDED', operationId: 'op-5', operationNumber: 'ZB0005' });
      if (url === '/partner/v1/qr/qr-1/refunds/again') return send(200, { refundId: 'rf-1' }, { 'Idempotent-Replayed': 'true' });
      return send(422, { code: 'REFUND_EXCEEDS_PAYMENT' });
    }
    if (request.headers.authorization !== 'Bearer token-1') return send(401, { code: 'UNAUTHORIZED' });
    if (url === '/api/v1/transfers' && body?.recipientPhone === 'bad') return send(400, { code: 'VALIDATION_ERROR' });
    if (url === '/api/v1/transfers' && Number(body?.amount) > 1000) return send(422, { code: 'INSUFFICIENT_FUNDS' });
    if (url === '/api/v1/transfers' && request.headers['idempotency-key'] === 'again') {
      return send(200, { id: 'op-1', number: 'ZB0001' }, { 'Idempotent-Replayed': 'true' });
    }
    if (url === '/api/v1/transfers') return send(201, { id: 'op-1', number: 'ZB0001' });
    if (url === '/api/v1/accounts') return send(200, { items: [{ id: 'acc-1' }, { id: 'acc-2' }] });
    return send(200, { items: [] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.KIT_BANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_kit`;
});

after(() => {
  server.close();
  delete process.env.KIT_BANK_URL;
});

beforeEach(() => {
  calls = [];
  smsText = 'Код входа в ЗапускБанк: 482913';
  smsBefore = [];
  smsAfter = [];
});

const http = (params: Record<string, unknown>) =>
  EXECUTORS['bank.http']!(params, { workDir: '/tmp', label: 'k7f3qa' }) as Promise<Record<string, unknown>>;

const post = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  http({
    asPhone: '+79001110001',
    method: 'POST',
    path: '/api/v1/transfers',
    body: { type: 'PHONE_TRANSFER', recipientPhone: '+79001110002', amount: 100 },
    headers: { 'Idempotency-Key': 'key-1', ...headers },
    ...extra,
  });

describe('bank.http', () => {
  it('входит по коду из эмулятора телефона и отправляет запрос с токеном и меткой попытки', async () => {
    const facts = await post();
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url.split('?')[0]}`),
      [
        'POST /api/v1/auth/login',
        'GET /api/v1/sandbox/sms',
        'POST /api/v1/auth/verify',
        'POST /api/v1/transfers',
      ],
    );
    assert.deepEqual(calls[0]?.body, { phone: '+79001110001' });
    assert.deepEqual(calls[2]?.body, { challengeId: 'ch-1', code: '482913' });
    const request = calls.at(-1);
    assert.equal(request?.headers.authorization, 'Bearer token-1');
    assert.equal(request?.headers['x-attempt-label'], 'k7f3qa');
    assert.equal(request?.headers['idempotency-key'], 'key-1');
    assert.equal(request?.body?.amount, 100);
    assert.deepEqual(facts, { status: 201, code: '', id: 'op-1', operationId: 'op-1', number: 'ZB0001', replayed: false, qrId: '', firstId: '' });
  });

  it('ответ 4xx — это результат для эталона, а не сбой: код ответа и код ошибки доступны', async () => {
    assert.deepEqual(await post({ body: { recipientPhone: 'bad' } }), {
      status: 400,
      code: 'VALIDATION_ERROR',
      id: '',
      operationId: '',
      number: '',
      replayed: false,
      qrId: '',
      firstId: '',
    });
    assert.equal((await post({ body: { amount: 5000 } })).code, 'INSUFFICIENT_FUNDS');
  });

  it('идентификатор первого элемента списка доступен как firstId: так эталон узнаёт основной счёт клиента', async () => {
    assert.equal((await http({ asPhone: '+79001110001', method: 'GET', path: '/api/v1/accounts' })).firstId, 'acc-1');
  });

  it('изменение шаблона методом PATCH уходит как PATCH, идентификатор созданного объекта доступен как id', async () => {
    const facts = await http({ asPhone: '+79001110001', method: 'PATCH', path: '/api/v1/templates/tpl-1', body: { name: 'Новое' } });
    assert.equal(calls.at(-1)?.method, 'PATCH');
    assert.deepEqual(calls.at(-1)?.body, { name: 'Новое' });
    assert.equal(facts.status, 200);
    const created = await post();
    assert.equal(created.id, 'op-1');
  });

  it('повтор с тем же ключом помечается replayed', async () => {
    const facts = await post({}, { 'Idempotency-Key': 'again' });
    assert.equal(facts.status, 200);
    assert.equal(facts.replayed, true);
  });

  it('метка попытки главнее заголовка из параметров: подменить её нельзя', async () => {
    await post({}, { 'X-Attempt-Label': 'other1' });
    assert.equal(calls.at(-1)?.headers['x-attempt-label'], 'k7f3qa');
  });

  it('новее кода входа может лежать СМС о переводе без кода: берётся ближайшее СМС с кодом', async () => {
    smsBefore = ['Перевод на 1 000 ₽ выполнен', 'Автоплатёж 130000 ₽ исполнен'];
    smsAfter = ['ЗапускБанк: код входа 111111. Никому его не сообщайте.'];
    const facts = await post();
    assert.equal(facts.status, 201);
    assert.ok(calls.some((call) => call.url.startsWith('/api/v1/sandbox/sms') && call.url.includes('limit=5')));
  });

  it('без кода в СМС вход не удаётся: сбой, а не 4xx', async () => {
    smsText = 'Код не пришёл';
    await assert.rejects(post(), /СМС с кодом входа не пришло/);
  });
});

describe('bank.partnerHttp', () => {
  const partner = (params: Record<string, unknown>) =>
    EXECUTORS['bank.partnerHttp']!(params, { workDir: '/tmp', label: 'k7f3qa' }) as Promise<Record<string, unknown>>;

  it('шлёт запрос с ключом магазина и меткой попытки, не входя в клиента', async () => {
    const result = await partner({ method: 'POST', path: '/partner/v1/qr', body: { orderId: 'o-1', amount: 1000, description: 'Заказ' } });
    assert.deepEqual(result, { status: 201, code: '', qrId: 'qr-1', payload: 'zbqr://pay?id=qr-1', qrStatus: 'CREATED', refundId: '', operationId: '', operationNumber: '', replayed: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers['x-partner-key'], 'zbk_test_lavka_7f3a91c4e2d85b60a1c9');
    assert.equal(calls[0]?.headers['x-attempt-label'], 'k7f3qa');
    assert.equal(calls[0]?.headers.authorization, undefined);
  });

  it('ключ магазина по умолчанию подставляется раньше переданных заголовков: эталон может проверить отказ с чужим ключом', async () => {
    const refused = await partner({ method: 'GET', path: '/partner/v1/qr/qr-1', headers: { 'X-Partner-Key': 'wrong-key' } });
    assert.equal(refused.status, 401);
    assert.equal(calls[0]?.headers['x-partner-key'], 'wrong-key');
  });

  it('возврат с ключом повтора отдаёт идентификаторы, отказ — код ошибки, повтор — признак replayed', async () => {
    const refund = await partner({ method: 'POST', path: '/partner/v1/qr/qr-1/refunds', body: { amount: 300 }, headers: { 'Idempotency-Key': 'refund-key-1' } });
    assert.equal(refund.refundId, 'rf-1');
    assert.equal(refund.qrStatus, 'PARTIALLY_REFUNDED');
    assert.equal(refund.operationNumber, 'ZB0005');
    assert.equal(calls[0]?.headers['idempotency-key'], 'refund-key-1');
    assert.equal((await partner({ method: 'POST', path: '/partner/v1/qr/qr-1/refunds/again', body: {} })).replayed, true);
    const refused = await partner({ method: 'POST', path: '/partner/v1/qr/qr-9/refunds', body: { amount: 1 } });
    assert.equal(refused.status, 422);
    assert.equal(refused.code, 'REFUND_EXCEEDS_PAYMENT');
  });
});
