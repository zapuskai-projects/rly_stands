export type SessionUi = {
  title: string;
  url: string;
};

export type SessionModule = {
  key: string;
  title: string;
  profile: string;
  minMemoryMb: number;
  requires?: string[];
  uis: SessionUi[];
  allowed: boolean;
  reason: string | null;
  /** Ключ учебного проекта, в окружение которого входит модуль. */
  project?: string | null;
};

export type SessionProject = { key: string; title: string; modules: string[] };

export type TaskProject = {
  key: string;
  title: string;
  memberId: string;
  trackTitle: string;
  code: string;
  release: string;
  state: 'DONE' | 'OPEN' | 'LOCKED';
  current: boolean;
  unlocksAfter: string | null;
};

export type TaskStatus = 'NOT_STARTED' | 'STARTED' | 'FAILED' | 'PASSED';

export type SessionTask = {
  id: string;
  title: string;
  project?: TaskProject | null;
  modules: Array<{ key: string; title: string }>;
  status: TaskStatus;
  attemptId: string | null;
  label: string | null;
  needsUpdate: boolean;
  missingPrimitives: string[];
  verifiedOnStand: boolean | null;
  verifiedFailureOnStand: boolean | null;
};

export type Session = {
  user: { name: string };
  /** Адрес сайта платформы для ссылок на страницу тикета. */
  webUrl?: string | null;
  token: { expiresAt: string };
  kit: { latestVersion: string; minVersion: string; offlineGraceHours: number };
  modules: SessionModule[];
  projects?: SessionProject[];
  tasks: SessionTask[];
};

export type TaskInput = 'none' | 'bug-report' | 'answer-field';

export type ProbeSpecPayload = { id: string; probe: string; params: Record<string, unknown> };

export type AttemptProbes = { attemptId: string; label: string; probes: ProbeSpecPayload[] };

export type TaskDefinition = {
  attemptId: string;
  label: string;
  input?: TaskInput;
  title: string;
  promptMd: string;
  hint: string | null;
  modules: Array<{ key: string; title: string }>;
  seed: Array<{ action: string; as?: string; params: Record<string, unknown> }>;
  probes: ProbeSpecPayload[];
  reference?: Array<{ action: string; as?: string; params: Record<string, unknown> }>;
};

export type AssertionOutcome = {
  id: string;
  title: string;
  passed: boolean;
  unavailable: boolean;
  hint: string | null;
  detail: string | null;
};

export type CheckOutcome = {
  attemptId: string;
  status: 'PASSED' | 'FAILED' | 'STARTED';
  result: {
    passed: boolean;
    unavailable: boolean;
    message: string;
    detail: string | null;
    reviewUnavailable?: boolean;
    assertionResults: AssertionOutcome[];
    summary: { passed: number; total: number };
  };
};

export type PlatformCall<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export type SessionResult =
  | { ok: true; session: Session }
  | { ok: false; kind: 'rejected'; message: string }
  | { ok: false; kind: 'unreachable'; message: string };
