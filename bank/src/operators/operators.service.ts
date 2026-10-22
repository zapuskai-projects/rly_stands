import type { Pool } from 'pg';
import { generateAccessToken, hashSecret } from '../auth/codes';
import { forbidden, unauthorized } from '../shared/errors';
import {
  findActiveOperatorSession,
  findOperatorWithHash,
  insertOperatorSession,
  revokeOperatorSession,
  type ActiveOperatorSession,
  type Operator,
} from './operators.repository';
import { hashPassword, verifyPassword } from './passwords';

export const OPERATOR_SESSION_TTL_SEC = 8 * 60 * 60;

const UNKNOWN_HASH = hashPassword('нет такого оператора');

export interface OperatorToken {
  accessToken: string;
  expiresInSec: number;
  operator: Operator;
}

export async function loginOperator(pool: Pool, login: string, password: string): Promise<OperatorToken> {
  const found = await findOperatorWithHash(pool, login);
  const valid = verifyPassword(password, found?.passwordHash ?? UNKNOWN_HASH);
  if (!found || !valid) throw unauthorized('INVALID_CREDENTIALS', 'Неверный логин или пароль');
  if (found.operator.status !== 'ACTIVE') throw forbidden('OPERATOR_BLOCKED', 'Учётная запись оператора заблокирована');
  const now = new Date();
  const accessToken = generateAccessToken();
  await insertOperatorSession(pool, found.operator.id, hashSecret(accessToken), now, new Date(now.getTime() + OPERATOR_SESSION_TTL_SEC * 1000));
  return { accessToken, expiresInSec: OPERATOR_SESSION_TTL_SEC, operator: found.operator };
}

export async function authenticateOperator(pool: Pool, token: string | null): Promise<ActiveOperatorSession> {
  if (!token) throw unauthorized('UNAUTHORIZED', 'Нужен токен оператора в заголовке Authorization: Bearer');
  const session = await findActiveOperatorSession(pool, hashSecret(token), new Date());
  if (!session || session.operator.status !== 'ACTIVE') {
    throw unauthorized('UNAUTHORIZED', 'Токен оператора недействителен или срок его действия истёк');
  }
  return session;
}

export async function logoutOperator(pool: Pool, sessionId: string): Promise<void> {
  await revokeOperatorSession(pool, sessionId, new Date());
}
