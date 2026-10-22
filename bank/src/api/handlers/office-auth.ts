import type { Pool } from 'pg';
import { loginOperator, logoutOperator } from '../../operators/operators.service';
import { operatorDto } from '../dto-office';
import type { Handler } from '../router';

interface LoginBody {
  login: string;
  password: string;
}

export function officeAuthHandlers(pool: Pool): Record<string, Handler> {
  return {
    loginOperator: async (ctx) => {
      const { login, password } = ctx.body as LoginBody;
      const issued = await loginOperator(pool, login.trim(), password);
      return {
        status: 200,
        body: { accessToken: issued.accessToken, tokenType: 'Bearer', expiresInSec: issued.expiresInSec, operator: operatorDto(issued.operator) },
      };
    },
    logoutOperator: async (ctx) => {
      await logoutOperator(pool, (ctx.operator as { sessionId: string }).sessionId);
      return { status: 204 };
    },
    getOperatorProfile: async (ctx) => ({ status: 200, body: operatorDto(ctx.operator as never) }),
  };
}
