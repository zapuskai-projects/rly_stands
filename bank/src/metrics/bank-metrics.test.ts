import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import express from 'express';
import { BankMetrics, channelOf } from './bank-metrics';
import { mountMetrics } from './route';

function sample(text: string, selector: string): number | null {
  const line = text.split('\n').find((item) => item.startsWith(`${selector} `));
  return line ? Number(line.slice(selector.length + 1)) : null;
}

describe('метрики банка', () => {
  it('способ перевода по типу операции', () => {
    assert.equal(channelOf('PHONE_TRANSFER'), 'PHONE');
    assert.equal(channelOf('OWN_TRANSFER'), 'OWN');
  });

  it('счётчик переводов считает каждый статус, в котором побывал перевод, и первый переход добавляет CREATED', async () => {
    const metrics = new BankMetrics();
    metrics.recordStatus('PHONE', 'CHECKING', 'CREATED', 0);
    metrics.recordStatus('PHONE', 'PROCESSING', 'CHECKING', 0);
    metrics.recordStatus('PHONE', 'COMPLETED', 'PROCESSING', 2.4);
    const text = await metrics.render();
    assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="CREATED"}'), 1);
    assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="CHECKING"}'), 1);
    assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="COMPLETED"}'), 1);
    assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="REFUNDED"}'), 0);
    assert.equal(sample(text, 'bank_transfers_total{channel="OWN",status="COMPLETED"}'), 0);
  });

  it('время до конечного статуса попадает в гистограмму только на конечных статусах', async () => {
    const metrics = new BankMetrics();
    metrics.recordStatus('PHONE', 'PROCESSING', 'CHECKING', 1);
    metrics.recordStatus('PHONE', 'COMPLETED', 'PROCESSING', 2.4);
    metrics.recordStatus('PHONE', 'REFUNDED', 'PROCESSING', 10.5);
    metrics.recordStatus('PHONE', 'FAILED', 'PROCESSING', -3);
    const text = await metrics.render();
    assert.equal(sample(text, 'bank_transfer_duration_seconds_count{channel="PHONE"}'), 3);
    assert.equal(sample(text, 'bank_transfer_duration_seconds_bucket{le="3",channel="PHONE"}'), 2);
    assert.equal(sample(text, 'bank_transfer_duration_seconds_bucket{le="12",channel="PHONE"}'), 3);
    assert.equal(sample(text, 'bank_transfer_duration_seconds_bucket{le="+Inf",channel="PHONE"}'), 3);
  });

  it('ответы СБП считаются по результату', async () => {
    const metrics = new BankMetrics();
    metrics.recordSbp('timeout');
    metrics.recordSbp('timeout');
    metrics.recordSbp('accepted');
    const text = await metrics.render();
    assert.equal(sample(text, 'bank_sbp_requests_total{result="timeout"}'), 2);
    assert.equal(sample(text, 'bank_sbp_requests_total{result="accepted"}'), 1);
    assert.equal(sample(text, 'bank_sbp_requests_total{result="rejected"}'), 0);
  });

  it('сброс обнуляет счётчики, но оставляет известные ряды', async () => {
    const metrics = new BankMetrics();
    metrics.recordStatus('PHONE', 'COMPLETED', 'PROCESSING', 2);
    metrics.recordSbp('accepted');
    metrics.reset();
    const text = await metrics.render();
    assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="COMPLETED"}'), 0);
    assert.equal(sample(text, 'bank_transfer_duration_seconds_count{channel="PHONE"}'), 0);
    assert.equal(sample(text, 'bank_sbp_requests_total{result="accepted"}'), 0);
  });

  it('GET /metrics отдаёт формат Prometheus', async () => {
    const metrics = new BankMetrics();
    metrics.recordStatus('PHONE', 'COMPLETED', 'PROCESSING', 2);
    const app = express();
    mountMetrics(app, metrics);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
      const text = await response.text();
      assert.match(text, /# TYPE bank_transfers_total counter/);
      assert.match(text, /# TYPE bank_transfer_duration_seconds histogram/);
      assert.equal(sample(text, 'bank_transfers_total{channel="PHONE",status="COMPLETED"}'), 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
