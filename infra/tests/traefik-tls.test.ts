import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hosts } from './env.js';

// *.broker.localhost sempre aponta para a máquina local; não depende do resolvedor do sistema.
const lookup: LookupFunction = (_host, opts, cb) =>
  opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);

const ca = readFileSync(fileURLToPath(new URL('../certs/ca/rootCA.pem', import.meta.url)));

function get(url: string): Promise<IncomingMessage> {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: u.hostname,
        path: u.pathname,
        port: secure ? hosts.httpsPort : hosts.httpPort,
        lookup,
        ca,
      },
      (res) => {
        res.resume();
        resolve(res);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('borda (Traefik + mkcert)', () => {
  it.each(['api', 'ws', 'bank', 'kyc', 'mail'])(
    'redireciona http://%s.broker.localhost para HTTPS',
    async (sub) => {
      const res = await get(`http://${sub}.broker.localhost/`);
      // Redirecionamento permanente: o Traefik responde 301 para GET e 308 para os demais métodos.
      expect([301, 308]).toContain(res.statusCode);
      expect(res.headers.location).toBe(`https://${sub}.broker.localhost/`);
    },
  );

  it('serve HTTPS com certificado da CA local válido para *.broker.localhost', async () => {
    // Se o certificado não fosse confiável pela CA do mkcert, a requisição falharia no TLS.
    const res = await get('https://mail.broker.localhost/');
    expect(res.statusCode).toBe(200);
  });
});
