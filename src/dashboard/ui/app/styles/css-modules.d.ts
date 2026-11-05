// esbuild turns a `*.module.css` import into the map of its local class names.
// TypeScript knows nothing about that, so the shape is declared once here.
//
// The map is deliberately typed as an index signature rather than as the exact
// set of classes the file defines: generating precise types would need a build
// step of its own, and the failure it would catch — a class renamed in the CSS
// but not in the component — shows up immediately on screen as an unstyled
// element. A global `.css` import carries no names and is declared as a side
// effect only, which is what `styles/tokens.css` is.

declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.css";
