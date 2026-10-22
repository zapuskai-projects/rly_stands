import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAccountNumber, isValidAccountNumber } from '../accounts/account-number';
import { isValidLuhn, buildCardNumber } from '../accounts/card';
import { isValidInn } from '../clients/inn';
import { BANK } from '../shared/bank-identity';
import { PERSONAS } from './personas';

describe('сид персон', () => {
  it('шесть персон с разными номерами и телефонами', () => {
    assert.equal(PERSONAS.length, 6);
    assert.equal(new Set(PERSONAS.map((p) => p.phone)).size, 6);
    assert.equal(new Set(PERSONAS.map((p) => p.number)).size, 6);
    for (const persona of PERSONAS) assert.match(persona.phone, /^\+79[0-9]{9}$/);
  });

  it('номера счетов и карт верны по ключу и Луну, порядковые номера не повторяются', () => {
    const serials = new Set<number>();
    const cardSerials = new Set<number>();
    for (const persona of PERSONAS) {
      for (const account of persona.accounts) {
        assert.equal(serials.has(account.serial), false);
        serials.add(account.serial);
        const number = buildAccountNumber(BANK.bik, { balanceAccount: account.balanceAccount, serial: account.serial });
        assert.equal(isValidAccountNumber(BANK.bik, number), true);
      }
      for (const card of persona.cards) {
        assert.equal(cardSerials.has(card.serial), false);
        cardSerials.add(card.serial);
        assert.equal(isValidLuhn(buildCardNumber(BANK.cardBin, card.serial)), true);
        assert.ok(persona.accounts.some((a) => a.serial === card.accountSerial));
      }
    }
  });

  it('ИНН предпринимателя и банка вымышлены, но верны по контрольным цифрам', () => {
    assert.equal(isValidInn(BANK.inn), true);
    for (const persona of PERSONAS) {
      if (persona.inn) assert.equal(isValidInn(persona.inn), true);
    }
  });

  it('у каждого клиента один основной счёт', () => {
    for (const persona of PERSONAS) {
      assert.equal(persona.accounts.filter((a) => a.isPrimary).length, 1);
    }
  });

  it('особые случаи персон: пенсионный тариф, нерезидент, арест, предприниматель', () => {
    const byName = (name: string) => PERSONAS.find((p) => p.fullName.includes(name));
    assert.equal(byName('Орлова')?.tariffCode, 'PENSION');
    assert.equal(byName('Ли Вэй')?.resident, false);
    assert.equal(byName('Мартынов')?.accounts[0]?.status, 'ARRESTED');
    assert.equal(byName('Гарипов')?.kind, 'ENTREPRENEUR');
    assert.equal(byName('Гарипов')?.accounts[0]?.balanceAccount, '40802');
  });
});
