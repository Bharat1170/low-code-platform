import type { ReactNode } from "react";
import type { FieldIconId } from "../types/form-builder.types.ts";

/* Maps the registry's serializable icon identifier to an inline SVG. */

const ICON_PATHS: Record<FieldIconId, ReactNode> = {
  text: (
    <>
      <path d="M4 7V5h12v2" />
      <path d="M10 5v10" />
      <path d="M8 15h4" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="2" />
      <path d="m3.5 6.5 6.5 5 6.5-5" />
    </>
  ),
  dropdown: (
    <>
      <rect x="3" y="4.5" width="14" height="11" rx="2" />
      <path d="m7.5 9 2.5 2.5L12.5 9" />
    </>
  ),
  checkbox: (
    <>
      <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
      <path d="m7 10 2.2 2.2L13 8" />
    </>
  ),
  date: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 3v3M13 3v3" />
    </>
  ),
};

export function FieldIcon({ icon }: { icon: FieldIconId }) {
  return (
    <svg
      className="fb-icon"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[icon]}
    </svg>
  );
}
