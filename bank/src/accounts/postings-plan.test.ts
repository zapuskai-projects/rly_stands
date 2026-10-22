import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { balanceDeltas, planTransferPostings } from './postings-plan';

const base = {
  fromAccountId: 'from',
  creditAccountId: 'to',
  incomeAccountId: 'income',
  transferDescription: 'Перевод',
  feeDescription: 'Комиссия',
};

describe('проводки перевода', () => {
  it('без комиссии — одна проводка на сумму перевода', () => {
    const postings = planTransferPostings({ ...base, amount: 150000n, fee: 0n });
    assert.equal(postings.length, 1);
    assert.deepEqual(
      [postings[0]?.debitAccountId, postings[0]?.creditAccountId, postings[0]?.amount, postings[0]?.kind],
      ['from', 'to', 150000n, 'TRANSFER'],
    );
  });

  it('с комиссией — вторая проводка в доход банка', () => {
    const postings = planTransferPostings({ ...base, amount: 150000n, fee: 3000n });
    assert.equal(postings.length, 2);
    assert.deepEqual(
      [postings[1]?.debitAccountId, postings[1]?.creditAccountId, postings[1]?.amount, postings[1]?.kind],
      ['from', 'income', 3000n, 'FEE'],
    );
  });

  it('суммы по всем счетам в сумме дают ноль', () => {
    const postings = planTransferPostings({ ...base, amount: 777777n, fee: 7778n });
    const total = [...balanceDeltas(postings).values()].reduce((sum, value) => sum + value, 0n);
    assert.equal(total, 0n);
  });

  it('счёт отправителя уменьшается на сумму и комиссию, получателя растёт на сумму', () => {
    const deltas = balanceDeltas(planTransferPostings({ ...base, amount: 150000n, fee: 3000n }));
    assert.equal(deltas.get('from'), -153000n);
    assert.equal(deltas.get('to'), 150000n);
    assert.equal(deltas.get('income'), 3000n);
  });

  it('нулевая и отрицательная суммы отвергаются', () => {
    assert.throws(() => planTransferPostings({ ...base, amount: 0n, fee: 0n }), RangeError);
    assert.throws(() => planTransferPostings({ ...base, amount: 10n, fee: -1n }), RangeError);
  });
});
