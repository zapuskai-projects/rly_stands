export const REVIEW_DEADLINE_MINUTES = 30;

export function reviewDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + REVIEW_DEADLINE_MINUTES * 60_000);
}

export function isReviewOverdue(deadline: Date, now: Date): boolean {
  return now.getTime() >= deadline.getTime();
}
