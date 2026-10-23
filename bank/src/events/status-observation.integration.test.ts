import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { BankMetrics } from '../metrics/bank-metrics';
import { pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';
import { reportStatusChange } from './status-report';
import type { StatusObservation } from './status-observation';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR, IP } = PHONES;

describe('метрики и журнал по сменам статуса, как их видит публикатор событий', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let seen: StatusObservation[];
  let stdout: Array<Record<string, unknown>>;
  let metrics: BankMetrics;
  let observe: (observation: StatusObservation) => void;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
    seen = [];
    stdout = [];
    metrics = new BankMetrics();
    const report = reportStatusChange(metrics);
    mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
      try {
        stdout.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      } catch {
        stdout.push({ raw: String(chunk) });
      }
      return true;
    });
    observe = (observation) => {
      seen.push(observation);
      report(observation);
    };
  });

  afterEach(async () => {
    mock.restoreAll();
    await h.close();
  });

  const drain = () => h.drain({ onStatusChanged: observe });
  const statusLogs = () => stdout.filter((line) => line.message === 'operation status changed');

  it('перевод по телефону между клиентами банка: путь до COMPLETED, способ PHONE, время неотрицательное', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const created = await sendTransfer(h, anna, 'obs-key-0001', phoneTransfer(from.number, PETR, 150_000));
    await drain();
    const mine = seen.filter((item) => item.operationId === pick(created.body, 'id'));
    assert.deepEqual(mine.map((item) => [item.previousStatus, item.status]), [['CREATED', 'CHECKING'], ['CHECKING', 'PROCESSING'], ['PROCESSING', 'COMPLETED']]);
    assert.ok(mine.every((item) => item.channel === 'PHONE' && item.operationNumber === pick(created.body, 'number') && item.durationSeconds >= 0));
    assert.equal(mine.at(-1)?.reasonCode, null);
    const text = await metrics.render();
    assert.match(text, /bank_transfers_total\{channel="PHONE",status="COMPLETED"\} 1\n/);
    assert.match(text, /bank_transfers_total\{channel="PHONE",status="CREATED"\} 1\n/);
    assert.match(text, /bank_transfer_duration_seconds_count\{channel="PHONE"\} 1\n/);
  });

  it('перевод между своими счетами считается способом OWN', async () => {
    const anna = await h.login(ANNA);
    const current = await accountOf(h, anna);
    const savings = await accountOf(h, anna, 1);
    await sendTransfer(h, anna, 'obs-key-0002', { type: 'OWN_TRANSFER', fromAccount: current.number, toAccount: savings.number, amount: 5_000 });
    await drain();
    assert.ok(seen.length >= 3 && seen.every((item) => item.channel === 'OWN'));
    assert.match(await metrics.render(), /bank_transfers_total\{channel="OWN",status="COMPLETED"\} 1\n/);
  });

  it('возврат после тайм-аута СБП: REFUNDED с причиной SBP_TIMEOUT попадает в метрики и в журнал с номером операции', async () => {
    const ip = await h.login(IP);
    const from = await accountOf(h, ip);
    const created = await sendTransfer(h, ip, 'obs-key-0003', phoneTransfer(from.number, '+79005550000', 100_000, { recipientBankCode: 'KEDR' }));
    h.sbp.mode = 'TIMEOUT';
    await drain();
    const refund = seen.find((item) => item.status === 'REFUNDED');
    assert.equal(refund?.operationNumber, pick(created.body, 'number'));
    assert.equal(refund?.reasonCode, 'SBP_TIMEOUT');
    assert.equal(refund?.previousStatus, 'PROCESSING');
    const log = statusLogs().find((line) => line.status === 'REFUNDED');
    assert.equal(log?.reasonCode, 'SBP_TIMEOUT');
    assert.equal(log?.operationNumber, pick(created.body, 'number'));
    assert.equal(log?.operationId, pick(created.body, 'id'));
    const text = await metrics.render();
    assert.match(text, /bank_transfers_total\{channel="PHONE",status="REFUNDED"\} 1\n/);
    assert.match(text, /bank_transfers_total\{channel="PHONE",status="COMPLETED"\} 0\n/);
  });

  it('смена статуса без отправленного события не попадает в наблюдение: брокер недоступен', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    await sendTransfer(h, anna, 'obs-key-0004', phoneTransfer(from.number, PETR, 150_000));
    await h.drain({ brokerDown: true, onStatusChanged: observe });
    assert.equal(seen.length, 0);
    assert.equal(statusLogs().length, 0);
  });
});
