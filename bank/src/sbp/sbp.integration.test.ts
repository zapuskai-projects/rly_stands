import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NOON_MOSCOW, operationOf, SEED_CORRESPONDENT_BALANCE, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';
import { HttpSbpGateway, type SbpRequest } from './gateway';
import { applySbpOutcome } from './outcome';
import { buildSbpApp } from './sbp-app';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { IP, GALINA } = PHONES;

describe('учебная СБП и ответы по переводам в другой банк', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  const toBank = (from: string, amount: number) => phoneTransfer(from, '+79005550000', amount, { recipientBankCode: 'KEDR' });

  async function transferWithFee(token: string): Promise<{ id: string; from: string }> {
    const from = await accountOf(h, token);
    const first = await sendTransfer(h, token, 'sbp-free-0001', toBank(from.number, 10_000_000));
    await h.drain();
    assert.equal(pick((await operationOf(h, token, first)).body, 'status'), 'COMPLETED');
    const second = await sendTransfer(h, token, 'sbp-fee-0001', toBank(from.number, 100_000), { 'X-Request-Id': 'req-sbp-0001' } as Record<string, string>);
    assert.equal(pick(second.body, 'fee'), 3_000);
    return { id: String(pick(second.body, 'id')), from: from.number };
  }

  it('банк принял перевод: COMPLETED, деньги ушли на корсчёт, комиссия в доход банка, уведомления только отправителю', async () => {
    const ip = await h.login(IP);
    const { id } = await transferWithFee(ip);
    await h.drain();
    const done = await h.api(ip, 'GET', `/api/v1/operations/${id}`);
    assert.equal(pick(done.body, 'status'), 'COMPLETED');
    assert.equal(pick(done.body, 'total'), 103_000);
    assert.equal(h.sbp.requests.at(-1)?.operationId, id);
    assert.equal(h.sbp.requests.at(-1)?.amount, 100_000);
    assert.equal(h.sbp.requests.at(-1)?.recipientBankCode, 'KEDR');

    const balances = await h.pool.query("SELECT kind, balance_kop FROM accounts WHERE kind IN ('CORRESPONDENT', 'INCOME') ORDER BY kind");
    assert.deepEqual(balances.rows.map((row) => [row.kind, row.balance_kop]), [['CORRESPONDENT', 10_100_000n + SEED_CORRESPONDENT_BALANCE], ['INCOME', 3_000n]]);
    const notifications = await h.pool.query('SELECT kind, channel FROM notifications WHERE operation_id = $1', [id]);
    assert.deepEqual(notifications.rows.map((row) => `${row.kind}:${row.channel}`).sort(), ['TRANSFER_COMPLETED:PUSH', 'TRANSFER_COMPLETED:SMS']);
    const report = await checkLedger(h.pool);
    assert.deepEqual(report.mismatchedAccounts, []);
    assert.equal(report.totalOfBalances, 0n);
  });

  it('банк получателя отказал: FAILED, холд снят, деньги и комиссия не списаны', async () => {
    h.sbp.mode = 'REJECTED';
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const created = await sendTransfer(h, galina, 'sbp-reject-0001', toBank(from.number, 1_000_000));
    await h.drain();
    const failed = await operationOf(h, galina, created);
    assert.equal(pick(failed.body, 'status'), 'FAILED');
    const history = pick(failed.body, 'statusHistory') as { status: string; reasonCode: string | null }[];
    assert.deepEqual(history.map((item) => item.status), ['CREATED', 'CHECKING', 'PROCESSING', 'FAILED']);
    assert.equal(history.at(-1)?.reasonCode, 'SBP_REJECTED');
    const account = await accountOf(h, galina);
    assert.deepEqual([account.balance, account.held, account.available], [from.balance, 0, from.balance]);
    assert.equal((await h.pool.query('SELECT 1 FROM postings WHERE operation_id = $1', [pick(created.body, 'id')])).rowCount, 0);
    assert.equal((await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [pick(created.body, 'id')])).rowCount, 0);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('СБП недоступна: FAILED с причиной SBP_UNAVAILABLE, средства свободны', async () => {
    h.sbp.mode = 'UNAVAILABLE';
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const created = await sendTransfer(h, galina, 'sbp-down-0001', toBank(from.number, 1_000_000));
    await h.drain();
    const failed = await operationOf(h, galina, created);
    assert.equal(pick(failed.body, 'status'), 'FAILED');
    assert.equal(pick(failed.body, 'statusHistory.3.reasonCode'), 'SBP_UNAVAILABLE');
    assert.equal((await accountOf(h, galina)).available, from.balance);
  });

  it('СБП не ответила: REFUNDED, деньги списаны и возвращены проводками, комиссия не берётся', async () => {
    const ip = await h.login(IP);
    const { id, from } = await transferWithFee(ip);
    h.sbp.mode = 'TIMEOUT';
    const before = await accountOf(h, ip);
    await h.drain();
    const refunded = await h.api(ip, 'GET', `/api/v1/operations/${id}`);
    assert.equal(pick(refunded.body, 'status'), 'REFUNDED');
    assert.equal(pick(refunded.body, 'fee'), 0);
    assert.equal(pick(refunded.body, 'total'), 100_000);
    assert.equal(pick(refunded.body, 'statusHistory.3.reasonCode'), 'SBP_TIMEOUT');

    const after = await accountOf(h, ip);
    assert.equal(after.balance, before.balance + 0);
    assert.equal(after.held, 0);
    const statement = await h.api(ip, 'GET', `/api/v1/accounts/${after.id}/statement?from=2026-10-20&to=2026-10-20`);
    const entries = (pick(statement.body, 'entries') as { direction: string; amount: number; operationId: string | null; description: string }[]).filter((entry) => entry.operationId === id);
    assert.deepEqual(entries.map((entry) => [entry.direction, entry.amount]), [['DEBIT', 100_000], ['CREDIT', 100_000]]);
    assert.match(entries[1]?.description ?? '', /Возврат перевода/);
    assert.equal(from, after.number);
    const accounts = await h.pool.query("SELECT kind, balance_kop FROM accounts WHERE kind IN ('CORRESPONDENT', 'INCOME') ORDER BY kind");
    assert.deepEqual(accounts.rows.map((row) => [row.kind, row.balance_kop]), [['CORRESPONDENT', 10_000_000n + SEED_CORRESPONDENT_BALANCE], ['INCOME', 0n]]);
    assert.equal((await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [id])).rowCount, 0);
    const refundEvents = h.events.filter((event) => event.topic === 'bank.payments.status-changed' && event.headers.operationId === id);
    const last = refundEvents.at(-1)?.payload as { previousStatus: string; status: string; reasonCode: string };
    assert.deepEqual([last.previousStatus, last.status, last.reasonCode], ['PROCESSING', 'REFUNDED', 'SBP_TIMEOUT']);
    const report = await checkLedger(h.pool);
    assert.deepEqual(report.mismatchedAccounts, []);
    assert.equal(report.totalOfBalances, 0n);
  });

  it('отправка, оборванная перезапуском, считается тайм-аутом и заканчивается возвратом', async () => {
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const created = await sendTransfer(h, galina, 'sbp-stuck-0001', toBank(from.number, 1_000_000));
    await h.drain({ sbp: false });
    await h.pool.query("UPDATE sbp_transfers SET state = 'SENT', dispatched_at = now() - interval '1 minute'");
    assert.equal(await h.recoverSbp(10_000), 1);
    assert.equal(pick((await operationOf(h, galina, created)).body, 'status'), 'REFUNDED');
    assert.equal(await h.recoverSbp(10_000), 0);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('второй ответ по уже закрытому переводу игнорируется', async () => {
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const created = await sendTransfer(h, galina, 'sbp-twice-0001', toBank(from.number, 1_000_000));
    await h.drain();
    assert.equal(pick((await operationOf(h, galina, created)).body, 'status'), 'COMPLETED');
    assert.equal(await applySbpOutcome(h.deps, String(pick(created.body, 'id')), { kind: 'TIMEOUT' }, 'req-late-0001'), false);
    assert.equal(pick((await operationOf(h, galina, created)).body, 'status'), 'COMPLETED');
  });

  describe('HTTP-обмен ядра с ролью sbp', () => {
    const request: SbpRequest = {
      operationId: '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10',
      operationNumber: 'ZB0000100001',
      amount: 100_000,
      currency: 'RUB',
      recipientPhone: '+79005550000',
      recipientBankCode: 'KEDR',
      senderBank: 'ZAPUSK',
      requestId: 'req-http-0001',
    };

    async function withSbp(mode: string, work: (gateway: HttpSbpGateway, stop: () => Promise<void>) => Promise<void>): Promise<void> {
      await h.pool.query('UPDATE scenario SET sbp_mode = $1 WHERE id = 1', [mode]);
      const server = buildSbpApp({ pool: h.pool, minDelayMs: 5, maxDelayMs: 10 }).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const stop = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
      try {
        await work(new HttpSbpGateway(url, 400), stop);
      } finally {
        await stop();
      }
    }

    it('режим NORMAL принимает перевод, REJECT отказывает', async () => {
      await withSbp('NORMAL', async (gateway) => {
        const answer = await gateway.send(request);
        assert.equal(answer.kind, 'ACCEPTED');
        assert.match(answer.kind === 'ACCEPTED' ? answer.reference : '', /^SBP-[0-9A-F]{8}$/);
      });
      await withSbp('REJECT', async (gateway) => {
        assert.deepEqual(await gateway.send(request), { kind: 'REJECTED', reason: 'RECIPIENT_BANK_DECLINED' });
      });
    });

    it('режим DOWN отвечает 503 и воспринимается как недоступность', async () => {
      await withSbp('DOWN', async (gateway) => {
        assert.equal((await gateway.send(request)).kind, 'UNAVAILABLE');
      });
    });

    it('режим TIMEOUT не отвечает, ядро фиксирует тайм-аут', async () => {
      await withSbp('TIMEOUT', async (gateway) => {
        assert.deepEqual(await gateway.send(request), { kind: 'TIMEOUT' });
      });
    });

    it('остановленная СБП — недоступность, а не тайм-аут', async () => {
      await withSbp('NORMAL', async (gateway, stop) => {
        await stop();
        assert.equal((await gateway.send(request)).kind, 'UNAVAILABLE');
      });
    });

    it('запрос неверного формата отвергается', async () => {
      await h.pool.query("UPDATE scenario SET sbp_mode = 'NORMAL' WHERE id = 1");
      const server = buildSbpApp({ pool: h.pool, minDelayMs: 0, maxDelayMs: 0 }).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/sbp/v1/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'x' }),
      });
      assert.equal(response.status, 400);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
