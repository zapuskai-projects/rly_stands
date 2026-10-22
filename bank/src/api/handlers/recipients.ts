import type { Pool } from 'pg';
import { findClientByPhone, findClientById } from '../../clients/clients.repository';
import { shortName } from '../../clients/names';
import { hasSuccessfulTransferTo } from '../../payments/operations.repository';
import type { RecipientNameLookup } from '../../sbp/gateway';
import { BANK } from '../../shared/bank-identity';
import { unprocessable } from '../../shared/errors';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  lookupRecipient: RecipientNameLookup;
}

export function recipientHandlers({ pool, lookupRecipient }: Deps): Record<string, Handler> {
  return {
    lookupRecipient: async (ctx: HandlerContext) => {
      const clientId = (ctx.session as { clientId: string }).clientId;
      const phone = String(ctx.query.phone);
      const bankCode = String(ctx.query.bankCode ?? BANK.code);
      let bankName: string = BANK.name;
      let displayName: string | null;
      if (bankCode === BANK.code) {
        const recipient = await findClientByPhone(pool, phone);
        if (!recipient || recipient.status !== 'ACTIVE' || recipient.technical) {
          throw unprocessable('RECIPIENT_NOT_FOUND', 'Клиент ЗапускБанка с таким номером телефона не найден');
        }
        if (recipient.id === clientId) throw unprocessable('RECIPIENT_IS_SENDER', 'Нельзя перевести деньги самому себе по номеру телефона');
        displayName = shortName(recipient.fullName);
      } else {
        const bank = await pool.query<{ name: string }>('SELECT name FROM partner_banks WHERE code = $1 AND active', [bankCode]);
        if (!bank.rows[0]) throw unprocessable('UNKNOWN_BANK', 'Банк получателя не найден в справочнике банков');
        bankName = bank.rows[0].name;
        displayName = await lookupRecipient(phone, bankCode);
      }
      const known = await hasSuccessfulTransferTo(pool, clientId, phone, bankCode);
      if (!(await findClientById(pool, clientId))) throw unprocessable('CLIENT_NOT_FOUND', 'Клиент не найден');
      return { status: 200, body: { phone, bankCode, bankName, displayName, known } };
    },
  };
}
