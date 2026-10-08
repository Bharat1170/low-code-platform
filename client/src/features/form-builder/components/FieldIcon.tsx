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
  textarea: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M6 7.5h8M6 10h8M6 12.5h5" />
    </>
  ),
  number: (
    <>
      <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12M3.5 12.5h12" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2.5" width="8" height="15" rx="2" />
      <path d="M9 14.5h2" />
    </>
  ),
  url: (
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" />
    </>
  ),
  radio: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2.5" fill="currentColor" />
    </>
  ),
  multiselect: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <path d="m4.5 6 1 1 2-2" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <path d="M12 6h5M12 14h5" />
    </>
  ),
  rating: (
    <>
      <path d="m10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6Z" />
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
