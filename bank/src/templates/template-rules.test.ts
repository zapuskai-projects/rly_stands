import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kindOfOperation, normalizeTemplateName, resolveAmount, templateCommand, templateNameIssue, type TemplateRecord } from './template-rules';

const base: TemplateRecord = {
  id: 'id',
  clientId: 'client',
  name: 'Аренда',
  kind: 'PHONE',
  fromAccountId: 'a1',
  fromAccountNumber: '40817810800000001000',
  toAccountId: null,
  toAccountNumber: null,
  recipientPhone: '+79001110002',
  recipientBankCode: 'ZAPUSK',
  recipientBankName: 'ЗапускБанк',
  amount: 2_500_000n,
  comment: 'Аренда',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
};

describe('правила шаблонов', () => {
  it('название обрезается и схлопывает пробелы, пустое и длиннее 40 символов отвергается', () => {
    assert.equal(normalizeTemplateName('  Аренда   квартиры '), 'Аренда квартиры');
    assert.equal(templateNameIssue(''), 'Название не может быть пустым');
    assert.equal(templateNameIssue('я'.repeat(40)), null);
    assert.match(templateNameIssue('я'.repeat(41)) ?? '', /длиннее 40/);
  });

  it('вид шаблона из операции: свои счета, внутри банка, через СБП', () => {
    assert.equal(kindOfOperation({ type: 'OWN_TRANSFER', route: 'INTERNAL' }), 'OWN');
    assert.equal(kindOfOperation({ type: 'PHONE_TRANSFER', route: 'INTERNAL' }), 'PHONE');
    assert.equal(kindOfOperation({ type: 'PHONE_TRANSFER', route: 'SBP' }), 'SBP');
  });

  it('сумма в запросе заменяет сумму шаблона, без обеих суммы нет', () => {
    assert.equal(resolveAmount(100n, 200n), 200n);
    assert.equal(resolveAmount(100n, undefined), 100n);
    assert.equal(resolveAmount(null, undefined), null);
    assert.equal(resolveAmount(null, 300n), 300n);
  });

  it('команда перевода собирается по виду шаблона', () => {
    assert.deepEqual(templateCommand(base, 5n, null), {
      type: 'PHONE_TRANSFER',
      fromAccount: '40817810800000001000',
      recipientPhone: '+79001110002',
      recipientBankCode: 'ZAPUSK',
      amount: 5n,
      comment: null,
    });
    const own = templateCommand({ ...base, kind: 'OWN', toAccountNumber: '40817810100000001001', recipientPhone: null, recipientBankCode: null }, 7n, 'c');
    assert.deepEqual(own, { type: 'OWN_TRANSFER', fromAccount: '40817810800000001000', toAccount: '40817810100000001001', amount: 7n, comment: 'c' });
    const sbp = templateCommand({ ...base, kind: 'SBP', recipientBankCode: 'NORTHWIND' }, 9n, null);
    assert.equal((sbp as { recipientBankCode: string }).recipientBankCode, 'NORTHWIND');
  });
});
