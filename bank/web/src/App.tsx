import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AutopaymentsPage } from './bank/AutopaymentsPage';
import { BankLayout } from './bank/BankLayout';
import { HistoryPage } from './bank/HistoryPage';
import { HomePage } from './bank/HomePage';
import { LoginPage } from './bank/LoginPage';
import { OperationPage } from './bank/OperationPage';
import { StatementPage } from './bank/StatementPage';
import { TemplateEditPage } from './bank/TemplateEditPage';
import { TemplateTransferPage } from './bank/TemplateTransferPage';
import { TransferPage } from './bank/TransferPage';
import { Loading } from './components/States';
import { ReleaseGate } from './components/ReleaseGate';
import { getToken, onUnauthorized, type Realm } from './lib/api';
import { ClientPage } from './office/ClientPage';
import { ClientsPage } from './office/ClientsPage';
import { NotificationsPage } from './office/NotificationsPage';
import { OfficeLayout } from './office/OfficeLayout';
import { OfficeLogin } from './office/OfficeLogin';
import { OfficeOperationPage } from './office/OfficeOperationPage';
import { OperationsPage } from './office/OperationsPage';
import { ReviewsPage } from './office/ReviewsPage';
import { TariffsPage } from './office/TariffsPage';

const DocsPage = lazy(async () => ({ default: (await import('./docs/DocsPage')).DocsPage }));

function Guard({ realm, children }: { realm: Realm; children: React.ReactNode }) {
  const location = useLocation();
  if (!getToken(realm)) {
    return <Navigate to={realm === 'client' ? '/login' : '/office/login'} state={{ from: location.pathname + location.search }} replace />;
  }
  return <>{children}</>;
}

export function App() {
  const navigate = useNavigate();
  useEffect(() => {
    onUnauthorized((realm) => navigate(realm === 'client' ? '/login' : '/office/login', { replace: true }));
  }, [navigate]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Guard realm="client"><BankLayout /></Guard>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/transfer" element={<TransferPage />} />
        <Route path="/operations/:id" element={<OperationPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/statement" element={<StatementPage />} />
        <Route path="/templates/:id/transfer" element={<ReleaseGate required="1.1"><TemplateTransferPage /></ReleaseGate>} />
        <Route path="/templates/:id/edit" element={<ReleaseGate required="1.1"><TemplateEditPage /></ReleaseGate>} />
        <Route path="/autopayments" element={<ReleaseGate required="1.1"><AutopaymentsPage /></ReleaseGate>} />
      </Route>
      <Route path="/office/login" element={<OfficeLogin />} />
      <Route path="/office" element={<Guard realm="office"><OfficeLayout /></Guard>}>
        <Route index element={<ReviewsPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="clients/:id" element={<ClientPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="operations/:id" element={<OfficeOperationPage />} />
        <Route path="tariffs" element={<TariffsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
      </Route>
      <Route path="/docs" element={<Suspense fallback={<Loading />}><DocsPage /></Suspense>} />
      <Route path="/docs/:slug" element={<Suspense fallback={<Loading />}><DocsPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
