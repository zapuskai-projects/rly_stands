import { OPERATOR_SEEDS } from '../../../src/seed/operators';
import { ROLE_LABEL } from './office-labels';

export interface OfficeDemoAccount {
  login: string;
  password: string;
  role: string;
}

export const OFFICE_DEMO_ACCOUNTS: readonly OfficeDemoAccount[] = OPERATOR_SEEDS.map((seed) => ({
  login: seed.login,
  password: seed.password,
  role: ROLE_LABEL[seed.role],
}));
