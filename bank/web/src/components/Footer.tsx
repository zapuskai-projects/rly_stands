import { useAsync } from '../lib/hooks';
import { fetchBankVersionLabel } from '../lib/release';

export function Footer() {
  const version = useAsync(fetchBankVersionLabel, []);
  return (
    <footer className="footer" data-testid="footer-disclaimer">
      {version.data ? (
        <>
          <span className="footer-version" data-testid="footer-version">{version.data}</span>
          {' · '}
        </>
      ) : null}
      Учебный банк платформы «Запускай». Клиенты, счета и операции вымышленные.
    </footer>
  );
}
