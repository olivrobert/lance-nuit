// runner/lib/ui-defaults.ts
//
// The two constants that the CLI registry and the server must agree on, kept in
// a module with no imports so declaring the `--port` option does not drag the
// whole dashboard — and, through it, the read model — into every process that
// merely parses arguments.

/** Loopback, and only loopback: `listen` is given this host explicitly, because
 *  omitting it makes Node bind every interface (spec 5.3). */
export const UI_HOST = "127.0.0.1";

/** Default dashboard port (H4). `--port 0` asks the kernel for a free one. */
export const DEFAULT_UI_PORT = 4848;
