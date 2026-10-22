import { logout, requestLoginCode, verifyLoginCode, type AuthDeps } from '../../auth/auth.service';
import { clientSummaryDto } from '../dto';
import type { Handler } from '../router';

interface LoginBody {
  phone: string;
}

interface VerifyBody {
  challengeId: string;
  code: string;
}

export function authHandlers(deps: AuthDeps): Record<string, Handler> {
  return {
    requestLoginCode: async (ctx) => {
      const challenge = await requestLoginCode(deps, (ctx.body as LoginBody).phone);
      return { status: 202, body: challenge };
    },
    verifyLoginCode: async (ctx) => {
      const { challengeId, code } = ctx.body as VerifyBody;
      const issued = await verifyLoginCode(deps, challengeId, code);
      return {
        status: 200,
        body: {
          accessToken: issued.accessToken,
          tokenType: 'Bearer',
          expiresInSec: issued.expiresInSec,
          client: clientSummaryDto(issued.client),
        },
      };
    },
    logout: async (ctx) => {
      await logout(deps, (ctx.session as { sessionId: string }).sessionId);
      return { status: 204 };
    },
  };
}
