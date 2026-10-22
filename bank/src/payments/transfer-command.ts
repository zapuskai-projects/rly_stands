import { createHash } from 'node:crypto';
import type { Kopecks } from '../accounts/money';

export type TransferCommand =
  | {
      type: 'OWN_TRANSFER';
      fromAccount: string;
      toAccount: string;
      amount: Kopecks;
      comment: string | null;
    }
  | {
      type: 'PHONE_TRANSFER';
      fromAccount: string;
      recipientPhone: string;
      recipientBankCode: string;
      amount: Kopecks;
      comment: string | null;
    };

export function hashTransferCommand(command: TransferCommand): string {
  const canonical =
    command.type === 'OWN_TRANSFER'
      ? [command.type, command.fromAccount, command.toAccount, command.amount.toString(), command.comment ?? '']
      : [
          command.type,
          command.fromAccount,
          command.recipientPhone,
          command.recipientBankCode,
          command.amount.toString(),
          command.comment ?? '',
        ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
