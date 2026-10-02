import { Marked, type Tokens } from "marked";
import { escapeHtml } from "./dom";

// Model output is untrusted: raw HTML is shown as text, never rendered.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    code({ text, lang }: Tokens.Code) {
      const label = lang ? `<span class="code-lang">${escapeHtml(lang.split(/\s/)[0])}</span>` : "";
      return `<div class="code-block">${label}<button class="copy" title="Копировать">Копировать</button><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
    link({ href, text }: Tokens.Link) {
      const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
      return `<a href="${escapeHtml(safe)}" title="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(`[картинка: ${text}]`);
    },
  },
});

export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}
