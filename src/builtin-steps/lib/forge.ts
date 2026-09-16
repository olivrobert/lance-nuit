// pipelines/lib/forge.ts
//
// Resolve the merge request URL. Extracted from old delivery prompts that made
// an agent run `glab mr view --output json | jq -r .web_url`.
//
// This file is NOT the Forge port: refactor plan 09 provides `modules/forge` with
// typed, reconcilable `push` and `create-merge-request`. Until then, isolate the
// only call tracker steps need, so `glab` has one contact point and one replacement.

import { STDERR_MARKER } from "../../exec/bash-runner.js";
import { runBashAsync } from "../../exec/runners.js";
import { errorMessage } from "../../lib/errors.js";
import { log } from "../../runtime/logging.js";

/** Shell command output: `output` may contain an appended stderr block. */
export type AsyncBashRun = (command: string) => Promise<{ ok: boolean; output: string }>;

export interface MergeRequestUrlOptions {
  /**
   * Receives an actionable warning when the optional GitLab CLI is unavailable.
   * Defaults to the runner logger; injection keeps this best-effort path easy
   * to assert without intercepting process stderr in tests.
   */
  warn?: (message: string) => void;
}

const defaultAsyncBashRun: AsyncBashRun = (command) => runBashAsync(command, { timeoutMs: 30_000 });

/** `runBashAsync` appends stderr after stdout behind this separator. For a command that
 *  returns JSON, retaining it would break parsing even when the response is valid. */
function stdoutOnly(output: string): string {
  const marker = output.indexOf(STDERR_MARKER);
  return marker === -1 ? output : output.slice(0, marker);
}

/**
 * GitLab API request rather than `glab mr view --output json`, which the original
 * prompts ran: that flag does not exist (`glab` 1.36: `unknown flag: --output`, with
 * no JSON output for this subcommand). Delivery therefore always published
 * "MR to create manually" even when one existed — a silent bug.
 *
 * `glab api` reuses `glab` authentication and host, and resolves `:id` and `:branch`
 * from the current repository. Filter on the source branch because the MR was just
 * created from the work branch at this stage.
 */
const MR_QUERY = 'glab api "projects/:id/merge_requests?source_branch=:branch&state=opened"';

const GLAB_MISSING_WARNING =
  "⚠ GitLab integration unavailable: the `glab` executable is required to resolve the merge request URL (install it or make it available in PATH).";

function looksLikeMissingGlab(output: string): boolean {
  return /(?:\bglab\b[\s\S]*(?:command not found|not found|no such file|ENOENT)|(?:command not found|not found|no such file|ENOENT)[\s\S]*\bglab\b)/i.test(
    output,
  );
}

/** First `web_url` from a GitLab response, whether it is an MR array or a single
 * object — the endpoint returns an array, but a filter with no match returns `[]`. */
function firstWebUrl(parsed: unknown): string {
  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!candidate || typeof candidate !== "object") return "";
  const url = (candidate as Record<string, unknown>).web_url;
  return typeof url === "string" ? url : "";
}

/**
 * Web URL of the current branch's merge request, or an empty string.
 *
 * Any failure returns `""` rather than an error: code has already been pushed at
 * this stage, so a missing URL is information to publish on the ticket, not a run
 * failure. The caller decides what to do.
 */
export async function mergeRequestUrlAsync(
  run: AsyncBashRun = defaultAsyncBashRun,
  options: MergeRequestUrlOptions = {},
): Promise<string> {
  const warn = options.warn ?? log;
  let result: { ok: boolean; output: string };
  try {
    result = await run(MR_QUERY);
  } catch (error) {
    const output = errorMessage(error);
    if (looksLikeMissingGlab(output)) warn(GLAB_MISSING_WARNING);
    return "";
  }
  if (!result.ok) {
    if (looksLikeMissingGlab(result.output)) warn(GLAB_MISSING_WARNING);
    return "";
  }
  try {
    return firstWebUrl(JSON.parse(stdoutOnly(result.output)));
  } catch {
    return "";
  }
}
