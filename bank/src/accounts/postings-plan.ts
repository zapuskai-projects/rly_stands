import type { Kopecks } from './money';

export type PostingKind = 'TRANSFER' | 'FEE' | 'OPENING' | 'REFUND';

export interface PostingDraft {
  debitAccountId: string;
  creditAccountId: string;
  amount: Kopecks;
  kind: PostingKind;
  description: string;
}

export interface TransferPostingsInput {
  fromAccountId: string;
  creditAccountId: string;
  incomeAccountId: string;
  amount: Kopecks;
  fee: Kopecks;
  transferDescription: string;
  feeDescription: string;
}

export function planTransferPostings(input: TransferPostingsInput): PostingDraft[] {
  if (input.amount <= 0n) throw new RangeError('Сумма перевода должна быть больше нуля');
  if (input.fee < 0n) throw new RangeError('Комиссия не может быть отрицательной');
  const postings: PostingDraft[] = [
    {
      debitAccountId: input.fromAccountId,
      creditAccountId: input.creditAccountId,
      amount: input.amount,
      kind: 'TRANSFER',
      description: input.transferDescription,
    },
  ];
  if (input.fee > 0n) {
    postings.push({
      debitAccountId: input.fromAccountId,
      creditAccountId: input.incomeAccountId,
      amount: input.fee,
      kind: 'FEE',
      description: input.feeDescription,
    });
  }
  return postings;
}

export function balanceDeltas(postings: readonly PostingDraft[]): Map<string, Kopecks> {
  const deltas = new Map<string, Kopecks>();
  for (const posting of postings) {
    deltas.set(posting.debitAccountId, (deltas.get(posting.debitAccountId) ?? 0n) - posting.amount);
    deltas.set(posting.creditAccountId, (deltas.get(posting.creditAccountId) ?? 0n) + posting.amount);
  }
  return deltas;
}
