import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReviewOverdue, reviewDeadline } from './deadline';

describe('срок ручной проверки', () => {
  const start = new Date('2026-10-20T20:40:00Z');

  it('крайний срок через 30 минут банковского времени', () => {
    assert.equal(reviewDeadline(start).toISOString(), '2026-10-20T21:10:00.000Z');
  });

  it('до срока проверка не просрочена, в момент срока уже просрочена', () => {
    const deadline = reviewDeadline(start);
    assert.equal(isReviewOverdue(deadline, new Date(deadline.getTime() - 1)), false);
    assert.equal(isReviewOverdue(deadline, deadline), true);
    assert.equal(isReviewOverdue(deadline, new Date(deadline.getTime() + 60_000)), true);
  });

  it('срок переходит через полночь', () => {
    assert.equal(reviewDeadline(new Date('2026-10-20T20:50:00Z')).toISOString(), '2026-10-20T21:20:00.000Z');
  });
});
