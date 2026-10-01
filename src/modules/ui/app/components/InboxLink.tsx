// A link back to the inbox, where the reader left it: same chip, same item.
// Used by every screen that is not the inbox.

import { Link } from "@tanstack/react-router";
import type { JSX, ReactNode } from "react";
import { inboxTarget } from "../lib/inbox-address.js";
import { useUi } from "../store/ui-store.js";

export function InboxLink({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  const last = useUi((state) => state.lastInbox);
  return (
    <Link {...inboxTarget(last)} className={className}>
      {children}
    </Link>
  );
}
