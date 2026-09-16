// Entry point of the dashboard bundle.
//
// The page is a single `<div id="app">` served by `static/index.html`; this file
// is what fills it. It imports the global stylesheet too, so `app.css` is a
// product of the same build as `app.js` and the two can never be out of step —
// there is no stylesheet in the repository that the bundle did not emit.
//
// WHY REACT REPLACED THE IMPERATIVE DOM RENDERER
// -----------------------------------------------
// The screen is repainted every fifteen seconds by a poll, and most polls change
// nothing. The previous renderer rebuilt the whole document each time, which made
// it responsible for putting back by hand everything the rebuild had destroyed:
// the caret and selection of the reply textarea, the scroll position of the list
// and of the sheet, which explorer directories were expanded, whether the run
// details panel was open. Each of those was a separate save-and-restore path, and
// each was a bug of its own. Reconciliation makes the whole category disappear:
// an element that keeps its type and its position in the tree is the same DOM
// node afterwards, so it keeps its state without anyone restoring it. That is the
// entire reason for the migration — not the components.
//
// WHAT REPLACED WHAT
// -------------------
//   the global `state` object   -> `store/store.ts`, an external store read
//                                  through `useSyncExternalStore`. It stays
//                                  outside React because the poll, the race
//                                  guard and the late answers all write to it
//                                  from outside a render.
//   `render()` and `el()`       -> `components/`, one file per zone.
//   the rules inside `render()` -> `lib/derive.ts`, pure and unit-tested.
//   one 1038-line `app.css`     -> a `*.module.css` beside each component, plus
//                                  `styles/tokens.css` for what must stay global.
//
// `StrictMode` is on in development and stays on in production: it costs a
// double render of pure components in development, which is exactly the pressure
// that keeps this front end free of the render-time side effects the DOM version
// was made of.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/tokens.css";

const container = document.getElementById("app");
if (!container) throw new Error("#app is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
