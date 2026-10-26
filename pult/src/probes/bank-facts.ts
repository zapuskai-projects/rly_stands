import { asArray, asRecord, num, str } from './http';

export function qrTotals(qrCodes: unknown[]) {
  const rows = qrCodes.map(asRecord);
  const sum = (field: string) => rows.reduce((total, row) => total + num(row[field]), 0);
  const withStatus = (...statuses: string[]) => rows.filter((row) => statuses.includes(str(row.status))).length;
  return {
    count: rows.length,
    paidCount: rows.filter((row) => str(row.operationId) !== '').length,
    refundedCount: withStatus('REFUNDED'),
    partiallyRefundedCount: withStatus('PARTIALLY_REFUNDED'),
    expiredCount: withStatus('EXPIRED'),
    cancelledCount: withStatus('CANCELLED'),
    totalAmountKop: sum('amountKop'),
    totalCreditedKop: sum('creditedKop'),
    totalCommissionKop: rows.filter((row) => str(row.operationId) !== '').reduce((total, row) => total + num(row.commissionKop), 0),
    totalRefundedKop: sum('refundedKop'),
  };
}

export function deliveryRows(deliveries: unknown[]) {
  return deliveries.map((item) => {
    const row = asRecord(item);
    const attempts = asArray(row.attempts).map(asRecord);
    const times = attempts.map((attempt) => Date.parse(str(attempt.at)));
    return {
      ...row,
      attemptCodes: attempts.map((attempt) => (attempt.statusCode == null ? str(attempt.error) : num(attempt.statusCode))),
      defectCodes: asArray(row.defects).map((mark) => str(asRecord(mark).code)),
      gapsSec: times.slice(1).map((time, index) => Math.round((time - (times[index] ?? time)) / 1000)),
      retried: num(row.attemptsMade) >= 2,
      firstAttempt5xx: num(attempts[0]?.statusCode) >= 500,
    };
  });
}

export function qrRows(qrCodes: unknown[]) {
  return qrCodes.map((item) => {
    const row = asRecord(item);
    return { ...row, multipleRefunds: asArray(row.refunds).length >= 2 };
  });
}

export function deliveryTotals(deliveries: unknown[]) {
  const rows = deliveries.map(asRecord);
  const withStatus = (status: string) => rows.filter((row) => row.status === status).length;
  const attemptsOf = (row: Record<string, unknown>) => num(row.attemptsMade);
  return {
    count: rows.length,
    deliveredCount: withStatus('DELIVERED'),
    failedCount: withStatus('FAILED'),
    pendingCount: withStatus('PENDING'),
    retriedCount: rows.filter((row) => attemptsOf(row) > 1).length,
    maxAttempts: Math.max(0, ...rows.map(attemptsOf)),
    paidEvents: rows.filter((row) => row.event === 'qr.paid').length,
    refundedEvents: rows.filter((row) => row.event === 'qr.refunded').length,
    defectiveCount: rows.filter((row) => asArray(row.defects).length > 0).length,
  };
}
