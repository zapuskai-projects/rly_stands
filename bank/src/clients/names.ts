export function maskPhone(phone: string): string {
  if (!/^\+79[0-9]{9}$/.test(phone)) throw new RangeError('Телефон: формат +79XXXXXXXXX');
  return `+7 ${phone.slice(2, 5)} ***-**-${phone.slice(-2)}`;
}

export function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts[0] === 'ИП' || parts.length < 2) return fullName.trim();
  const last = parts[parts.length - 1] as string;
  return `${parts[0]} ${last.charAt(0)}.`;
}
