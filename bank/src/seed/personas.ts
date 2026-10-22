import { rubles, type Kopecks } from '../accounts/money';
import type { AccountKind, AccountStatus } from '../accounts/accounts.repository';
import type { ClientKind } from '../clients/clients.repository';

export interface AccountSeed {
  serial: number;
  balanceAccount: '40817' | '40802';
  kind: AccountKind;
  title: string;
  balance: Kopecks;
  isPrimary: boolean;
  status?: AccountStatus;
}

export interface CardSeed {
  serial: number;
  accountSerial: number;
  product: string;
  expiryMonth: number;
  expiryYear: number;
}

export interface HistorySeed {
  daysAgo: number;
  hour: number;
  minute: number;
  amount: Kopecks;
  recipientPhone: string;
  recipientBankCode: string;
  recipientName: string;
}

export interface PersonaSeed {
  customerSince: string;
  openingDaysAgo?: number;
  history?: HistorySeed[];
  number: string;
  fullName: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  tariffCode: 'START' | 'PENSION';
  accounts: AccountSeed[];
  cards: CardSeed[];
}

export const PERSONAS: readonly PersonaSeed[] = [
  {
    customerSince: '2024-03-12',
    openingDaysAgo: 30,
    history: [
      { daysAgo: 18, hour: 21, minute: 5, amount: rubles(6_300), recipientPhone: '+79000000022', recipientBankCode: 'LAZURIT', recipientName: 'Ольга С.' },
      { daysAgo: 6, hour: 12, minute: 20, amount: rubles(4_000), recipientPhone: '+79000000021', recipientBankCode: 'NORTHWIND', recipientName: 'Иван К.' },
      { daysAgo: 1, hour: 18, minute: 47, amount: rubles(2_500), recipientPhone: '+79000000021', recipientBankCode: 'NORTHWIND', recipientName: 'Иван К.' },
    ],
    number: '10000001',
    fullName: 'Анна Соколова',
    phone: '+79001110001',
    kind: 'INDIVIDUAL',
    resident: true,
    inn: null,
    tariffCode: 'START',
    accounts: [
      { serial: 1000, balanceAccount: '40817', kind: 'CURRENT', title: 'Текущий счёт', balance: rubles(120_000), isPrimary: true },
      { serial: 1001, balanceAccount: '40817', kind: 'SAVINGS', title: 'Накопительный счёт', balance: rubles(15_000), isPrimary: false },
    ],
    cards: [{ serial: 1, accountSerial: 1000, product: 'Старт', expiryMonth: 9, expiryYear: 2030 }],
  },
  {
    customerSince: '2022-09-01',
    number: '10000002',
    fullName: 'Пётр Ильин',
    phone: '+79001110002',
    kind: 'INDIVIDUAL',
    resident: true,
    inn: null,
    tariffCode: 'START',
    accounts: [
      { serial: 1002, balanceAccount: '40817', kind: 'CURRENT', title: 'Зарплатный счёт', balance: rubles(450_000), isPrimary: true },
      { serial: 1003, balanceAccount: '40817', kind: 'SAVINGS', title: 'Накопительный счёт', balance: rubles(200_000), isPrimary: false },
    ],
    cards: [{ serial: 2, accountSerial: 1002, product: 'Зарплатная', expiryMonth: 3, expiryYear: 2031 }],
  },
  {
    customerSince: '2019-05-20',
    number: '10000003',
    fullName: 'Галина Орлова',
    phone: '+79001110003',
    kind: 'INDIVIDUAL',
    resident: true,
    inn: null,
    tariffCode: 'PENSION',
    accounts: [
      { serial: 1004, balanceAccount: '40817', kind: 'CURRENT', title: 'Пенсионный счёт', balance: rubles(85_000), isPrimary: true },
    ],
    cards: [{ serial: 3, accountSerial: 1004, product: 'Пенсионная', expiryMonth: 11, expiryYear: 2029 }],
  },
  {
    customerSince: '2023-02-14',
    number: '10000004',
    fullName: 'ИП Гарипов Р. Ф.',
    phone: '+79001110004',
    kind: 'ENTREPRENEUR',
    resident: true,
    inn: '610012345620',
    tariffCode: 'START',
    accounts: [
      { serial: 1005, balanceAccount: '40802', kind: 'SETTLEMENT', title: 'Расчётный счёт', balance: rubles(1_250_000), isPrimary: true },
    ],
    cards: [],
  },
  {
    customerSince: '2025-06-03',
    number: '10000005',
    fullName: 'Ли Вэй',
    phone: '+79001110005',
    kind: 'INDIVIDUAL',
    resident: false,
    inn: null,
    tariffCode: 'START',
    accounts: [
      { serial: 1006, balanceAccount: '40817', kind: 'CURRENT', title: 'Текущий счёт', balance: rubles(300_000), isPrimary: true },
    ],
    cards: [{ serial: 4, accountSerial: 1006, product: 'Стандарт', expiryMonth: 6, expiryYear: 2030 }],
  },
  {
    customerSince: '2021-11-30',
    number: '10000006',
    fullName: 'Сергей Мартынов',
    phone: '+79001110006',
    kind: 'INDIVIDUAL',
    resident: true,
    inn: null,
    tariffCode: 'START',
    accounts: [
      {
        serial: 1007,
        balanceAccount: '40817',
        kind: 'CURRENT',
        title: 'Текущий счёт',
        balance: rubles(60_000),
        isPrimary: true,
        status: 'ARRESTED',
      },
    ],
    cards: [{ serial: 5, accountSerial: 1007, product: 'Стандарт', expiryMonth: 1, expiryYear: 2030 }],
  },
];
