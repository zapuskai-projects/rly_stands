const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_12_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_12_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) {
    sum += Number(digits[i]) * (weights[i] as number);
  }
  return (sum % 11) % 10;
}

export function isValidInn(inn: string): boolean {
  if (/^[0-9]{10}$/.test(inn)) {
    return checkDigit(inn, WEIGHTS_10) === Number(inn[9]);
  }
  if (/^[0-9]{12}$/.test(inn)) {
    return checkDigit(inn, WEIGHTS_12_FIRST) === Number(inn[10]) && checkDigit(inn, WEIGHTS_12_SECOND) === Number(inn[11]);
  }
  return false;
}
