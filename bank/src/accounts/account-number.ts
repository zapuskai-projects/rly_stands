const WEIGHTS = [7, 1, 3] as const;
const KEY_INDEX = 8;
const RUB_CURRENCY_CODE = '810';
const DEFAULT_BRANCH = '0000';

export interface AccountNumberParts {
  balanceAccount: string;
  serial: number;
  currencyCode?: string;
  branch?: string;
}

function assertDigits(value: string, length: number, name: string): void {
  if (!new RegExp(`^[0-9]{${length}}$`).test(value)) throw new RangeError(`${name}: нужно ${length} цифр`);
}

function weightedSum(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    sum += (Number(digits[i]) * (WEIGHTS[i % WEIGHTS.length] as number)) % 10;
  }
  return sum;
}

function keyPrefix(bik: string, account: string): string {
  return account.startsWith('301') ? `0${bik.slice(4, 6)}` : bik.slice(6, 9);
}

export function calculateAccountKey(bik: string, account: string): number {
  assertDigits(bik, 9, 'БИК');
  assertDigits(account, 20, 'Номер счёта');
  const zeroed = `${account.slice(0, KEY_INDEX)}0${account.slice(KEY_INDEX + 1)}`;
  return ((weightedSum(keyPrefix(bik, account) + zeroed) % 10) * 3) % 10;
}

export function isValidAccountNumber(bik: string, account: string): boolean {
  if (!/^[0-9]{9}$/.test(bik) || !/^[0-9]{20}$/.test(account)) return false;
  return weightedSum(keyPrefix(bik, account) + account) % 10 === 0;
}

export function buildAccountNumber(bik: string, parts: AccountNumberParts): string {
  const currencyCode = parts.currencyCode ?? RUB_CURRENCY_CODE;
  const branch = parts.branch ?? DEFAULT_BRANCH;
  assertDigits(parts.balanceAccount, 5, 'Балансовый счёт');
  assertDigits(currencyCode, 3, 'Код валюты');
  assertDigits(branch, 4, 'Филиал');
  if (!Number.isInteger(parts.serial) || parts.serial < 0 || parts.serial > 9_999_999) {
    throw new RangeError('Порядковый номер счёта: от 0 до 9999999');
  }
  const draft = `${parts.balanceAccount}${currencyCode}0${branch}${String(parts.serial).padStart(7, '0')}`;
  const key = calculateAccountKey(bik, draft);
  return `${draft.slice(0, KEY_INDEX)}${key}${draft.slice(KEY_INDEX + 1)}`;
}
