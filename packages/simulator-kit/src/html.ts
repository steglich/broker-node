/** HTML já escapado; só `html`` ` e `raw()` produzem um. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Date) return escapeHtml(value.toISOString());
  return escapeHtml(value);
}

/**
 * Template de HTML que escapa toda interpolação (os dados vêm de quem chama a API do simulador,
 * então são não confiáveis). Listas são concatenadas; `null`/`undefined`/`false` somem.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!));
  return new SafeHtml(out);
}

export const raw = (value: string) => new SafeHtml(value);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d2129; --bg: #f7f7f8; --card: #fff; --muted: #6b7280; --line: #e3e4e8; --accent: #0b6bcb; --warn: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6e7ea; --bg: #15171c; --card: #1d2027; --muted: #9aa1ad; --line: #2c303a; --accent: #5aa7f0; --warn: #f59e0b; } }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 0; color: var(--fg); background: var(--bg); }
  header { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
  header strong { font-size: 16px; } header span { color: var(--warn); margin-left: 8px; font-size: 12px; }
  main { padding: 16px; max-width: 1200px; margin: 0 auto; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; overflow-x: auto; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  form.inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
  input, select, button { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
  button { background: var(--accent); color: #fff; border-color: var(--accent); cursor: pointer; }
  .muted { color: var(--muted); } code { font-size: 12px; }
`;

/** Página da UI de inspeção (RN-SIM-005). Deixa claro que é um ambiente simulado. */
export function page(title: string, body: SafeHtml): string {
  return html`<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <header>
          <strong>${title}</strong><span>SIMULADO: nenhum dado ou dinheiro real</span>
        </header>
        <main>${body}</main>
      </body>
    </html>`.value;
}

/** Tabela simples: `columns` são os títulos; cada linha, as células na mesma ordem. */
export function table(
  columns: readonly string[],
  rows: readonly unknown[][],
  empty = 'Nada por aqui ainda.',
): SafeHtml {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<table>
    <thead>
      <tr>
        ${columns.map((c) => html`<th>${c}</th>`)}
      </tr>
    </thead>
    <tbody>
      ${rows.map(
        (r) =>
          html`<tr>
            ${r.map((c) => html`<td>${c}</td>`)}
          </tr>`,
      )}
    </tbody>
  </table>`;
}
