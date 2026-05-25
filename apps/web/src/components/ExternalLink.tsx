// External-link primitive — plain anchor that opens in a new tab.
// http:// gets a dashed warning underline; https:// is clean. Spec: 1.5.7.

import type { ReactNode } from 'react';

export interface ExternalLinkProps {
  href: string;
  text?: string;
  insecure?: boolean;
  children?: ReactNode;
}

export function ExternalLink({ href, text, insecure, children }: ExternalLinkProps) {
  const isInsecure = insecure ?? href.startsWith('http://');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="pc-external-link"
      data-insecure={isInsecure ? 'true' : undefined}
      title={isInsecure ? `Insecure (http) — ${href}` : href}
    >
      {children ?? text ?? href}
    </a>
  );
}
