// modules/dashboard-home/user-list.ts
//
// `users.json`: the names allowed to use the dashboard. It is edited by hand
// (H2); the dashboard only creates it, empty, and reads it.

import { mkdirSync } from "node:fs";
import type { DashboardPaths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./json-file.js";

/** Display names accepted in `users.json` and in the identity cookie. The same
 *  shape the runner accepts for `LANCENUIT_ACTOR`, so a name chosen here can be
 *  handed to a launch unchanged. */
const USER_NAME = /^[\w .-]{1,64}$/;

export function isValidUserName(value: unknown): value is string {
  return typeof value === "string" && USER_NAME.test(value);
}

export class FileUserList {
  constructor(private readonly paths: DashboardPaths | null) {}

  /** Create the file, empty but valid, when it is missing. An existing file is
   *  never rewritten — that would erase a name someone just added. */
  ensure(): void {
    if (!this.paths) return;
    mkdirSync(this.paths.dir, { recursive: true });
    if (readJson(this.paths.users) === undefined) writeJsonAtomic(this.paths.users, { users: [] });
  }

  /**
   * Names allowed to use the dashboard, in file order.
   *
   * An empty list is a legitimate state, not an error: it means nobody has been
   * declared yet, and the choice page says so instead of the server failing.
   */
  list(): string[] {
    if (!this.paths) return [];
    const parsed = readJson(this.paths.users);
    const users = parsed && typeof parsed === "object" ? (parsed as { users?: unknown }).users : undefined;
    if (!Array.isArray(users)) return [];

    const names: string[] = [];
    for (const entry of users) {
      if (isValidUserName(entry) && !names.includes(entry)) names.push(entry);
    }
    return names;
  }

  /** True when `name` may act as an identity: declared, and shaped like a name. */
  isKnown(name: string | undefined): name is string {
    return isValidUserName(name) && this.list().includes(name);
  }
}
