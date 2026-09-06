/**
 * brand-icons.tsx
 * Madar — Official product marks used in the sidebar (kept offline in-repo).
 *
 *  - VSCodeIcon:    the Visual Studio Code mark (simple-icons v12 path,
 *                   pre-removal; renders with currentColor so it adapts).
 *  - OpencodeIcon:  the opencode terminal-in-square mark, embedded verbatim
 *                   from https://opencode.ai/favicon.svg (fixed dark fills —
 *                   matches the app's dark theme).
 */

interface IconProps {
  width?: number | string;
  height?: number | string;
  class?: string;
  style?: string;
}

export function VSCodeIcon({ width = 13, height = 13, class: cls, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={width}
      height={height}
      class={cls}
      style={style}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  );
}

export function OpencodeIcon({ width = 13, height = 13, class: cls, style }: IconProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={width}
      height={height}
      class={cls}
      style={style}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="96" fill="#131010" />
      <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="white"
      />
    </svg>
  );
}
