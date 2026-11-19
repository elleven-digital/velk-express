/**
 * Line icons of the panel proposal: 24px grid, 1.6 stroke, drawn with
 * currentColor, shown at 16px unless `size` says otherwise. Always next to a
 * text label or inside a labelled button, so they are hidden from screen
 * readers.
 */
const PATHS = {
  home: <path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19Z" />,
  inbox: (
    <>
      <path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" />
      <path d="M5.6 5h12.8l2.6 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19v-5.5Z" />
    </>
  ),
  brief: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  receipt: (
    <>
      <path d="M5.5 3v18l2.25-1.5L10 21l2-1.5 2 1.5 2.25-1.5L18.5 21V3l-2.25 1.5L14 3l-2 1.5L10 3 7.75 4.5Z" />
      <path d="M9 9h6M9 13h6" />
    </>
  ),
  users: (
    <path d="M9 11.5A3.5 3.5 0 1 0 9 4.5a3.5 3.5 0 0 0 0 7ZM2.5 20v-.5A4.5 4.5 0 0 1 7 15h4a4.5 4.5 0 0 1 4.5 4.5v.5M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20v-.5a4.5 4.5 0 0 0-3-4.24" />
  ),
  sliders: (
    <>
      <path d="M20 7h-8M8 7H4M20 17h-4M12 17H4" />
      <circle cx="10" cy="7" r="2" />
      <circle cx="14" cy="17" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M10.3 4.4 2.9 17.5a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17h.01" />
    </>
  ),
  userplus: (
    <path d="M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20v-.5A4.5 4.5 0 0 1 8 15h4.5M18 14v6M15 17h6" />
  ),
  ext: <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />,
  logout: <path d="M9 20.5H5.5A1.5 1.5 0 0 1 4 19V5a1.5 1.5 0 0 1 1.5-1.5H9M16 16.5l4.5-4.5L16 7.5M20.5 12h-11" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  reply: <path d="M9.5 8 5 12.5 9.5 17M5.5 12.5H14a5 5 0 0 1 5 5V19" />,
  list: <path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 16-5-5L5 20" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  paperclip: <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />,
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  pencil: <path d="M14.5 5.5 18.5 9.5M4 20l1-4.5L15.8 4.7a1.5 1.5 0 0 1 2.1 0l1.4 1.4a1.5 1.5 0 0 1 0 2.1L8.5 19 4 20Z" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </>
  ),
  trash: <path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `flex-none ${className}` : "flex-none"}
    >
      {PATHS[name]}
    </svg>
  );
}
