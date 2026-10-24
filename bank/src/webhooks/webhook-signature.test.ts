import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retryDelaySec, serializeWebhook, signWebhook, WEBHOOK_MAX_ATTEMPTS, type WebhookBody } from './webhook-signature';
import { isLoopbackWebhookHost, webhookUrlIssue } from './webhook-url';

const body: WebhookBody = {
  event: 'qr.paid',
  qrId: '7b0c5d12-3a4e-4f6a-9d21-5c8e1f0a2b34',
  orderId: 'order-1',
  amount: 123450,
  refundedAmount: 0,
  operationId: '0b8f6a52-6c0e-4a7e-8d4b-2f1d3c5e7a90',
  occurredAt: '2026-10-20T12:03:11.420+03:00',
};

describe('подпись уведомления', () => {
  it('известный секрет и известная строка дают эталонную подпись', () => {
    assert.equal(signWebhook('key', 'hello'), 'sha256=9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b');
  });

  it('подписывается ровно та строка, которая уходит в теле', () => {
    const text = serializeWebhook(body);
    assert.equal(text, '{"event":"qr.paid","qrId":"7b0c5d12-3a4e-4f6a-9d21-5c8e1f0a2b34","orderId":"order-1","amount":123450,"refundedAmount":0,"operationId":"0b8f6a52-6c0e-4a7e-8d4b-2f1d3c5e7a90","occurredAt":"2026-10-20T12:03:11.420+03:00"}');
    assert.equal(signWebhook('my-shared-secret', text), 'sha256=3e71a0bbf387ecb93a0ef5536c2c096ed03dc7c301f880efe832b06d361ade6e');
  });

  it('другой секрет или другое тело дают другую подпись', () => {
    const text = serializeWebhook(body);
    assert.notEqual(signWebhook('other', text), signWebhook('my-shared-secret', text));
    assert.notEqual(signWebhook('my-shared-secret', `${text} `), signWebhook('my-shared-secret', text));
  });
});

describe('расписание повторов', () => {
  it('после неудач повтор через 10, 30 и 60 секунд, после четвёртой попытки — конец', () => {
    assert.deepEqual([1, 2, 3, 4].map(retryDelaySec), [10, 30, 60, null]);
    assert.equal(WEBHOOK_MAX_ATTEMPTS, 4);
    assert.equal(retryDelaySec(5), null);
  });
});

describe('адрес приёмника', () => {
  it('http и https принимаются, в том числе host.docker.internal и недоступные имена', () => {
    for (const url of ['http://host.docker.internal:8080/hook', 'https://shop.example.com/qr', 'http://unreachable.invalid/x']) {
      assert.equal(webhookUrlIssue(url), null, url);
    }
  });

  it('другие схемы, мусор и слишком длинный адрес отвергаются', () => {
    for (const url of ['ftp://host/x', 'file:///etc/passwd', 'javascript:alert(1)', 'host.docker.internal:8080', 'not a url', '', `http://h/${'a'.repeat(500)}`]) {
      assert.notEqual(webhookUrlIssue(url), null, url);
    }
  });
});

describe('адрес, указывающий на сам банк', () => {
  it('localhost, вся сеть 127.0.0.0/8, ::1 и 0.0.0.0 распознаются, в том числе в записи без точек', () => {
    for (const url of ['http://localhost/x', 'http://LocalHost:8080/x', 'http://127.0.0.1/x', 'http://127.200.3.4/x', 'http://127.1/x', 'http://2130706433/x', 'http://[::1]:8080/x', 'http://0.0.0.0/x', 'https://a.localhost/x']) {
      assert.equal(isLoopbackWebhookHost(url), true, url);
    }
  });

  it('обычные адреса, host.docker.internal и похожие имена не затронуты', () => {
    for (const url of ['http://host.docker.internal:8080/x', 'http://128.0.0.1/x', 'http://10.0.0.5/x', 'https://shop.example.com/localhost', 'http://localhost-shop.example.com/x', 'http://[2001:db8::1]/x', 'мусор']) {
      assert.equal(isLoopbackWebhookHost(url), false, url);
    }
  });
});
