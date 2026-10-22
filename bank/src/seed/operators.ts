import type { OperatorRole } from '../operators/operators.repository';

export interface OperatorSeed {
  login: string;
  password: string;
  fullName: string;
  shortName: string;
  role: OperatorRole;
}

export const OPERATOR_SEEDS: readonly OperatorSeed[] = [
  { login: 'operator', password: 'operator-2026', fullName: 'Олег Рябов', shortName: 'Олег Р.', role: 'OPERATOR' },
  { login: 'senior', password: 'senior-2026', fullName: 'Светлана Крылова', shortName: 'Светлана К.', role: 'SENIOR' },
];
