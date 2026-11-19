"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/*
 * The panel's top bar shows "Section / Page". The section comes from the URL;
 * the page's own name (a ticket's title, a client's name) only the page
 * knows, so pages hand it up with <PageCrumb> (PageHeader does it for string
 * titles). The setter and the value live in separate contexts so pages never
 * re-render when the label changes.
 */
const SetCrumb = createContext<((label: string | null) => void) | null>(null);
const CrumbLabel = createContext<string | null>(null);

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  return (
    <SetCrumb.Provider value={setLabel}>
      <CrumbLabel.Provider value={label}>{children}</CrumbLabel.Provider>
    </SetCrumb.Provider>
  );
}

/** Names the current page in the top bar. Renders nothing; a no-op outside the panel. */
export function PageCrumb({ label }: { label: string }) {
  const set = useContext(SetCrumb);
  useEffect(() => {
    if (!set) return;
    set(label);
    return () => set(null);
  }, [set, label]);
  return null;
}

export function useCrumbLabel(): string | null {
  return useContext(CrumbLabel);
}
