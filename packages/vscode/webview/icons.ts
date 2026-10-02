// Brand mark: the "d" with a pulse line, drawn with currentColor (CSS sets the brand color).
const LOGO_PATHS = `<circle cx="20" cy="34" r="14"/><path class="pulse" d="M34 4 V40 L39 48 L45 18 L50 44 L54 34 H68"/>`;

export const LOGO = `<svg viewBox="-8 -10 90 72" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">${LOGO_PATHS}</g></svg>`;

/** Just the pulse, animated while the agent works. */
export const PULSE = `<svg viewBox="28 -2 46 56" fill="none" aria-hidden="true"><path class="pulse-line" d="M34 4 V40 L39 48 L45 18 L50 44 L54 34 H68" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const icon = (d: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  folder: icon(`<path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z"/>`),
  file: icon(`<path d="M4 1.5h5l3 3v10h-8z"/><path d="M9 1.5v3h3"/>`),
  search: icon(`<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l4 4"/>`),
  edit: icon(`<path d="M10.5 2.5l3 3-8 8h-3v-3z"/>`),
  terminal: icon(`<path d="M2 3.5l4 4-4 4"/><path d="M8 12.5h6"/>`),
  plan: icon(`<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2 4h.5M2 8h.5M2 12h.5"/>`),
  check: icon(`<path d="M3 8.5l3 3 7-7"/>`),
  cross: icon(`<path d="M4 4l8 8M12 4l-8 8"/>`),
  clip: icon(`<path d="M13 7.5l-5.5 5.5a3.2 3.2 0 01-4.5-4.5l6-6a2.1 2.1 0 013 3l-6 6a1 1 0 01-1.5-1.5l5.5-5.5"/>`),
  image: icon(`<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.3"/><path d="M14.5 11l-4-4-7 6.5"/>`),
  code: icon(`<path d="M5.5 4l-4 4 4 4M10.5 4l4 4-4 4"/>`),
  book: icon(`<path d="M2 3c2-1 4-1 6 .5 2-1.5 4-1.5 6-.5v10c-2-1-4-1-6 .5-2-1.5-4-1.5-6-.5z"/><path d="M8 3.5v10"/>`),
  undo: icon(`<path d="M5 3L2 6l3 3"/><path d="M2 6h7.5a4 4 0 010 8H6"/>`),
  diff: icon(`<path d="M4.5 1.5v9M1 6h7M9.5 14.5h5.5M12 1.5v9"/>`),
  plus: icon(`<path d="M8 3v10M3 8h10"/>`),
  stop: icon(`<rect x="4" y="4" width="8" height="8" rx="1"/>`),
  send: icon(`<path d="M2 8h11M9 4l4 4-4 4"/>`),
  warn: icon(`<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.5"/>`),
  copy: icon(`<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2"/>`),
};

export function toolIcon(name: string): string {
  switch (name) {
    case "list_files":
      return ICONS.folder;
    case "read_file":
      return ICONS.file;
    case "search":
      return ICONS.search;
    case "write_file":
    case "edit_file":
      return ICONS.edit;
    case "run_command":
      return ICONS.terminal;
    default:
      return ICONS.code;
  }
}
