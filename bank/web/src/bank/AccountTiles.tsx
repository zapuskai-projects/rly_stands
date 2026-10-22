import { formatAccountNumber, formatMoney, lastDigits } from '../lib/format';
import type { Account } from '../lib/types';

function holdNote(account: Account, reviewing: boolean): string | null {
  if (account.held <= 0) return null;
  return `Заморожено ${formatMoney(account.held)}${reviewing ? ' · перевод на проверке' : ' · переводы в обработке'}`;
}

export function AccountTiles({ accounts, reviewing }: { accounts: Account[]; reviewing: boolean }) {
  return (
    <section aria-label="Счета" className="tiles" data-testid="account-tiles">
      {accounts.map((account) => {
        const card = account.cards[0];
        const note = holdNote(account, reviewing);
        if (card) {
          return (
            <div key={account.id} className="tile tile-brand" data-testid="account-tile" data-account-number={account.number}>
              <div className="tile-head">
                <span>Карта «{card.product}»</span>
                <span className="mono">•• {lastDigits(card.maskedNumber)}</span>
              </div>
              <div className="tile-amount" data-testid="tile-available">
                {formatMoney(account.available)}
              </div>
              <div className="tile-note">{note ?? formatAccountNumber(account.number)}</div>
            </div>
          );
        }
        return (
          <div key={account.id} className="tile" data-testid="account-tile" data-account-number={account.number}>
            <div className="tile-head">
              <span style={{ color: 'var(--muted)' }}>{account.title}</span>
              {account.status === 'ARRESTED' ? <span className="pill pill-bad">Арест</span> : null}
            </div>
            <div className="tile-amount" data-testid="tile-available">
              {formatMoney(account.available)}
            </div>
            <div className="tile-sub">{note ?? formatAccountNumber(account.number)}</div>
          </div>
        );
      })}
    </section>
  );
}
