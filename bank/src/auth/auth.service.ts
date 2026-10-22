import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { findClientById, findClientByPhone, type Client } from '../clients/clients.repository';
import { withTransaction } from '../db/pool';
import { insertNotification } from '../notifications/notifications.repository';
import { BANK } from '../shared/bank-identity';
import { forbidden, notFound, unauthorized } from '../shared/errors';
import {
  consumeChallenge,
  findActiveSession,
  insertChallenge,
  insertSession,
  lockChallenge,
  registerFailedAttempt,
  revokeSession,
  supersedeOpenChallenges,
  type ActiveSession,
} from './auth.repository';
import {
  generateAccessToken,
  generateLoginCode,
  hashSecret,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_SEC,
  SESSION_TTL_SEC,
} from './codes';

export interface AuthDeps {
  pool: Pool;
  clock: BankClock;
}

export interface IssuedChallenge {
  challengeId: string;
  expiresInSec: number;
}

export interface IssuedToken {
  accessToken: string;
  expiresInSec: number;
  client: Client;
}

export async function requestLoginCode(deps: AuthDeps, phone: string): Promise<IssuedChallenge> {
  return withTransaction(deps.pool, async (tx) => {
    const client = await findClientByPhone(tx, phone);
    if (!client) throw notFound('CLIENT_NOT_FOUND', 'Клиент с таким номером телефона не найден');
    if (client.status !== 'ACTIVE') throw forbidden('CLIENT_BLOCKED', 'Вход для этого клиента закрыт');
    const now = new Date();
    await supersedeOpenChallenges(tx, client.id, now);
    const code = generateLoginCode();
    const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_SEC * 1000);
    const challengeId = await insertChallenge(tx, client.id, hashSecret(code), expiresAt, now);
    await insertNotification(tx, {
      clientId: client.id,
      phone: client.phone,
      channel: 'SMS',
      kind: 'LOGIN_CODE',
      text: `${BANK.name}: код входа ${code}. Никому его не сообщайте.`,
      createdAt: deps.clock.now(),
    });
    return { challengeId, expiresInSec: LOGIN_CODE_TTL_SEC };
  });
}

type VerifyOutcome =
  | { ok: true; token: string; client: Client }
  | { ok: false; code: string; message: string };

export async function verifyLoginCode(deps: AuthDeps, challengeId: string, code: string): Promise<IssuedToken> {
  const outcome = await withTransaction<VerifyOutcome>(deps.pool, async (tx) => {
    const now = new Date();
    const challenge = await lockChallenge(tx, challengeId);
    if (!challenge || challenge.consumedAt) {
      return { ok: false, code: 'INVALID_CHALLENGE', message: 'Запрос кода не найден или уже использован. Запросите новый код' };
    }
    if (challenge.expiresAt <= now) {
      return { ok: false, code: 'CODE_EXPIRED', message: 'Срок действия кода истёк. Запросите новый код' };
    }
    if (challenge.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      return { ok: false, code: 'CODE_ATTEMPTS_EXCEEDED', message: 'Превышено число попыток ввода кода. Запросите новый код' };
    }
    if (hashSecret(code) !== challenge.codeHash) {
      await registerFailedAttempt(tx, challenge.id);
      const left = LOGIN_CODE_MAX_ATTEMPTS - challenge.attempts - 1;
      return { ok: false, code: 'INVALID_CODE', message: `Неверный код. Осталось попыток: ${left}` };
    }
    const client = await findClientById(tx, challenge.clientId);
    if (!client || client.status !== 'ACTIVE') {
      return { ok: false, code: 'INVALID_CHALLENGE', message: 'Вход для этого клиента закрыт' };
    }
    await consumeChallenge(tx, challenge.id, now);
    const token = generateAccessToken();
    await insertSession(tx, client.id, hashSecret(token), now, new Date(now.getTime() + SESSION_TTL_SEC * 1000));
    return { ok: true, token, client };
  });
  if (!outcome.ok) throw unauthorized(outcome.code, outcome.message);
  return { accessToken: outcome.token, expiresInSec: SESSION_TTL_SEC, client: outcome.client };
}

export async function authenticate(deps: AuthDeps, token: string | null): Promise<ActiveSession> {
  if (!token) throw unauthorized('UNAUTHORIZED', 'Нужен токен в заголовке Authorization: Bearer');
  const session = await findActiveSession(deps.pool, hashSecret(token), new Date());
  if (!session) throw unauthorized('UNAUTHORIZED', 'Токен недействителен или срок его действия истёк');
  return session;
}

export async function logout(deps: AuthDeps, sessionId: string): Promise<void> {
  await revokeSession(deps.pool, sessionId, new Date());
}
