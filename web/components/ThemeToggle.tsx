"use client";

import { useEffect, useState } from "react";

// M1-W3 fix: DESIGN.md §1 "Zeus is light by default, with a dark theme for
// long desk sessions" — the app must not silently follow the OS dark
// preference; it needs an explicit toggle. The default is applied by an
// inline script in app/layout.tsx (before hydration, to avoid a flash);
// this component only reads the *current* documentElement.dataset.theme
// on mount (useEffect, so it never disagrees with the server-rendered
// "light" markup during hydration) and lets the user flip it, persisting
// the choice to localStorage with try/catch (private windows/blocked
// storage must never crash the toggle).

const STORAGE_KEY = "zeus-theme";

function readStoredTheme(): "light" | "dark" | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "dark" ? "dark" : stored === "light" ? "light" : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: "light" | "dark"): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private window, blocked site data) —
    // the toggle still works for this page load via the DOM attribute.
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    writeStoredTheme(next);
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className="btn btn--secondary"
      aria-pressed={theme === "dark"}
      aria-label={label}
      onClick={toggle}
      title={label}
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.5 9.7A5.8 5.8 0 0 1 6.3 2.5a5.8 5.8 0 1 0 7.2 7.2Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.3" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 1.3v1.6M8 13.1v1.6M14.7 8h-1.6M2.9 8H1.3M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span aria-hidden="true">{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}

// Exported so app/layout.tsx's inline pre-hydration script and this
// component agree on the storage key/values without duplicating literals.
export const THEME_STORAGE_KEY = STORAGE_KEY;

export function readStoredThemeForTest(): "light" | "dark" | null {
  return readStoredTheme();
}
