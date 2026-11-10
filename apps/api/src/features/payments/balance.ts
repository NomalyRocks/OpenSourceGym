/** A payment as far as balance math is concerned. */
export interface BalancePayment {
  amountMinor: number;
  /** Null or absent while the payment stands */
  void?: unknown;
}

export interface Balance {
  paidMinor: number;
  balanceMinor: number;
}

/**
 * `balance = price - sum of non-voided payments`. The payments collection is the
 * only source of truth; nothing stores a running total that could drift.
 */
export function computeBalance(
  priceMinor: number,
  payments: readonly BalancePayment[],
): Balance {
  let paidMinor = 0;
  for (const payment of payments) {
    if (payment.void) continue;
    paidMinor += payment.amountMinor;
  }
  return { paidMinor, balanceMinor: priceMinor - paidMinor };
}

/** Balance from an already-summed paid total. */
export function balanceFromPaid(
  priceMinor: number,
  paidMinor: number,
): Balance {
  return { paidMinor, balanceMinor: priceMinor - paidMinor };
}

/** Whether a payment of `amountMinor` fits the remaining balance. */
export function fitsBalance(
  amountMinor: number,
  balanceMinor: number,
): boolean {
  return (
    Number.isInteger(amountMinor) &&
    amountMinor >= 1 &&
    amountMinor <= balanceMinor
  );
}
