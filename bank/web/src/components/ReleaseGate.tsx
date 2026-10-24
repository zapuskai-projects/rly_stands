import { Navigate } from 'react-router-dom';
import { gateDecision, useBankReleaseState } from '../lib/release';
import { Loading } from './States';

export function ReleaseGate({ required, children }: { required: string; children: React.ReactNode }) {
  const { release, loading } = useBankReleaseState();
  const decision = gateDecision(loading, release, required);
  if (decision === 'wait') return <Loading />;
  if (decision === 'hide') return <Navigate to="/" replace />;
  return <>{children}</>;
}
