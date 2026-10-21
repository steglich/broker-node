#!/usr/bin/env node
/**
 * CLI da DLQ (RN-MSG-B-036). Fala com a API administrativa do serviço, que é quem tem os handlers.
 *
 *   broker-dlq --url http://localhost:8080 list [--status PENDING] [--consumer x]
 *   broker-dlq --url ... inspect <id>
 *   broker-dlq --url ... reprocess <id> --operator <quem> --note <obs> [--corrected arquivo.json]
 *   broker-dlq --url ... discard <id> --operator <quem> --justification <motivo>
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export async function runDlqCli(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string', default: process.env['DLQ_ADMIN_URL'] ?? 'http://localhost:8080' },
      status: { type: 'string' },
      consumer: { type: 'string' },
      operator: { type: 'string' },
      note: { type: 'string', default: '' },
      justification: { type: 'string' },
      corrected: { type: 'string' },
    },
  });
  const [command, id] = positionals;
  const base = `${values.url}/admin/dlq`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    const body = (await res.json()) as unknown;
    out(JSON.stringify(body, null, 2));
    return res.ok ? 0 : 1;
  };

  switch (command) {
    case 'list': {
      const q = new URLSearchParams();
      if (values.status) q.set('status', values.status);
      if (values.consumer) q.set('consumer', values.consumer);
      return call(q.size ? `?${q}` : '');
    }
    case 'inspect':
      if (!id) break;
      return call(`/${id}`);
    case 'reprocess':
      if (!id || !values.operator) break;
      return call(`/${id}/reprocess`, {
        method: 'POST',
        body: JSON.stringify({
          operator: values.operator,
          note: values.note,
          ...(values.corrected
            ? { corrected: JSON.parse(readFileSync(values.corrected, 'utf8')) as unknown }
            : {}),
        }),
      });
    case 'discard':
      if (!id || !values.operator || !values.justification) break;
      return call(`/${id}/discard`, {
        method: 'POST',
        body: JSON.stringify({ operator: values.operator, justification: values.justification }),
      });
  }
  out(
    'uso: broker-dlq [--url URL] list|inspect <id>|reprocess <id> --operator X [--note Y] [--corrected arq]|discard <id> --operator X --justification Y',
  );
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runDlqCli(process.argv.slice(2));
}
