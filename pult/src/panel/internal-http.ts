import { request } from 'node:http';
import { PanelError } from './errors';

export function internalTimeout(path: string, body?: unknown): number {
  if (path === '/internal/bridge' && (body as { verb?: string } | undefined)?.verb === 'complete') return 30 * 60000;
  return ['/internal/plan', '/internal/operation', '/internal/policy'].includes(path) ? 120000 : 15000;
}

export async function longInternalCall(path: string, body: unknown, key: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = request({ hostname: 'stands-kit-panel', port: 18490, path, method: 'POST', headers: { 'X-Panel-Key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }, (res) => {
      let length = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8 * 1024 * 1024) { req.destroy(new Error('Ответ контроллера слишком большой')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code: string; message: string; details?: unknown } };
          if ((res.statusCode ?? 500) >= 400) reject(new PanelError(res.statusCode ?? 500, value.error?.code ?? 'CONTROLLER_ERROR', value.error?.message ?? 'Контроллер недоступен', value.error?.details));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => { req.destroy(new Error('Контроллер не завершил обновление за 30 минут; проверьте сохранённое состояние')); }, timeoutMs);
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.end(encoded);
  });
}
