export function luhnCheckDigit(payload: string): number {
  if (!/^[0-9]+$/.test(payload)) throw new RangeError('Номер карты состоит из цифр');
  let sum = 0;
  for (let i = payload.length - 1, double = true; i >= 0; i -= 1, double = !double) {
    let digit = Number(payload[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidLuhn(number: string): boolean {
  if (!/^[0-9]{2,}$/.test(number)) return false;
  return luhnCheckDigit(number.slice(0, -1)) === Number(number[number.length - 1]);
}

export function buildCardNumber(bin: string, serial: number): string {
  if (!/^[0-9]{6}$/.test(bin)) throw new RangeError('BIN: нужно 6 цифр');
  if (!Number.isInteger(serial) || serial < 0 || serial > 999_999_999) {
    throw new RangeError('Порядковый номер карты: от 0 до 999999999');
  }
  const payload = `${bin}${String(serial).padStart(9, '0')}`;
  return `${payload}${luhnCheckDigit(payload)}`;
}

export function maskCardNumber(number: string): string {
  if (!/^[0-9]{16}$/.test(number)) throw new RangeError('Номер карты: нужно 16 цифр');
  return `${number.slice(0, 6)}******${number.slice(12)}`;
}
