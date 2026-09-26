// modules/ui/http/identity.ts
//
// Who sent a request: the name the identity cookie carries, checked against
// `users.json` on every request, so removing a name takes effect at once.

import type { IncomingMessage } from "node:http";
import { type FileUserList, isValidUserName } from "../../dashboard-home/index.js";
import { parseCookies, USER_COOKIE } from "../cookies.js";

export interface Identity {
  /** The name the cookie carries, whether or not it is still declared. */
  claimed?: string;
  /** The same name, only when `users.json` still lists it. */
  user?: string;
}

export function identityOf(req: IncomingMessage, users: FileUserList): Identity {
  const claimed = parseCookies(req.headers.cookie).get(USER_COOKIE);
  if (!isValidUserName(claimed)) return {};
  return users.isKnown(claimed) ? { claimed, user: claimed } : { claimed };
}
