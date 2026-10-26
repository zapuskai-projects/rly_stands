export function profileKey(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}
