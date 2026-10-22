import { createContext, useContext } from 'react';
import type { Operator } from '../lib/types';

export interface OfficeOutletContext {
  reloadPending: () => void;
}

export const OperatorContext = createContext<Operator | null>(null);

export function useOperator(): Operator {
  const value = useContext(OperatorContext);
  if (!value) throw new Error('Оператор недоступен вне операционного офиса');
  return value;
}
