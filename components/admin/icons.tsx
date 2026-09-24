/** モックの塗りつぶしアイコン（Lucide に同じ形がないもの） */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = { viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true } as const;

export function HomeFillIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M11.2 2.6a1.3 1.3 0 0 1 1.6 0l8.4 6.9c.5.4.8 1 .8 1.6V20a1.5 1.5 0 0 1-1.5 1.5H15v-6.2a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v6.2H3.5A1.5 1.5 0 0 1 2 20v-8.9c0-.6.3-1.2.8-1.6z" />
    </svg>
  );
}

export function PinFillIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 1.8a7.7 7.7 0 0 0-7.7 7.7c0 5.5 6.3 11.8 7 12.5a1 1 0 0 0 1.4 0c.7-.7 7-7 7-12.5A7.7 7.7 0 0 0 12 1.8Zm0 10.6a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
    </svg>
  );
}

export function UsersFillIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="7.5" r="3.9" />
      <path d="M1.5 19.2c0-3.6 3-6 7.5-6s7.5 2.4 7.5 6v.8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
      <circle cx="16.8" cy="8.3" r="3.2" />
      <path d="M17.2 13.3c3.3.2 5.3 2.3 5.3 5.4v.8a1 1 0 0 1-1 1h-3.3v-.9c0-2.5-.8-4.6-2.4-6.1.4-.1.9-.2 1.4-.2z" />
    </svg>
  );
}
