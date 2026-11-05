//
// Public surface of the dashboard module. The `ui` command imports this file;
// everything below it is internal to the module.

export { DEFAULT_UI_PORT, startUiServer } from "./server.js";
// Exported so the command can check that the front-end bundle was built before
// it binds a socket and serves a page that would be blank.
export { staticDir } from "./static-files.js";
// The server owns the shape of an interactive run as the routes answer it.
// The command builds the session command from the backends it composed.
export { reopenSessionCommand } from "./terminals.js";
