import { moscowParts } from '../clock/moscow';
import type { Kopecks } from '../accounts/money';
import type { AntifraudDecision, RuleHit } from '../events/payloads';

export const RULES = {
  NEW_RECIPIENT: { points: 30, description: 'Новый получатель' },
  NIGHT_TIME: { points: 25, description: 'Перевод ночью, с 23:00 до 06:00 по Москве' },
  AMOUNT_ABOVE_USUAL: { points: 17, description: 'Сумма больше обычной в 3 раза или первый перевод клиента' },
  HIGH_FREQUENCY: { points: 20, description: 'Больше 5 переводов за час' },
} as const;

export type RuleCode = keyof typeof RULES;

const USUAL_AMOUNT_FACTOR = 3n;
const FREQUENCY_LIMIT_PER_HOUR = 5;

export interface PaymentFacts {
  recipientKnown: boolean;
  priorTransfers: { count: number; totalAmount: Kopecks };
  priorInLastHour: number;
}

export interface ScoreInput {
  createdAt: Date;
  amount: Kopecks;
  facts: PaymentFacts;
}

export interface Thresholds {
  review: number;
  reject: number;
}

export function isNight(instant: Date): boolean {
  const { hour } = moscowParts(instant);
  return hour >= 23 || hour < 6;
}

export function isAboveUsual(amount: Kopecks, prior: PaymentFacts['priorTransfers']): boolean {
  return prior.count === 0 ? amount > 0n : amount * BigInt(prior.count) > USUAL_AMOUNT_FACTOR * prior.totalAmount;
}

export function scorePayment(input: ScoreInput): { score: number; rules: RuleHit[] } {
  const hits: RuleCode[] = [];
  if (!input.facts.recipientKnown) hits.push('NEW_RECIPIENT');
  if (isNight(input.createdAt)) hits.push('NIGHT_TIME');
  if (isAboveUsual(input.amount, input.facts.priorTransfers)) hits.push('AMOUNT_ABOVE_USUAL');
  if (input.facts.priorInLastHour + 1 > FREQUENCY_LIMIT_PER_HOUR) hits.push('HIGH_FREQUENCY');
  const rules = hits.map((code) => ({ code, points: RULES[code].points }));
  return { score: rules.reduce((sum, rule) => sum + rule.points, 0), rules };
}

export function decideByScore(score: number, thresholds: Thresholds): AntifraudDecision {
  if (score >= thresholds.reject) return 'REJECT';
  if (score >= thresholds.review) return 'REVIEW';
  return 'APPROVE';
}

export function describeRule(code: string): string {
  return code in RULES ? RULES[code as RuleCode].description : code;
}
