---
paths:
  - "src/modules/ui/app/**/*.tsx"
exclude:
  - "src/modules/ui/app/index.tsx"
---

# Constraints — Dashboard React components

Scope: `src/modules/ui/app/**/*.tsx` matching `React function component returning JSX, typed `JSX.Element`, rendering read-model shapes in the local dashboard.`.

Tooling checked: `biome.json`, `eslint.config.mjs`, `tsconfig.ui.json`, `package.json`. None of the rules below are covered by this tooling.

## Static Rules

```rules
UIC-003 | absent | export default | MUST NOT A component file has no default export
UIC-005 | absent | \buseState\b | MUST NOT A component does not hold screen state in useState: that state lives in the store
```

## Semantic Rules

- MUST: A component is an exported named function declaration with an explicit JSX.Element return type. Trigger: definition of a component rendered by the dashboard. Anchor: export function Name(...): JSX.Element, with import type { JSX } from "react". — consistency, non-blocking (20/20)
- MUST NOT: An optional JSX block is not rendered via the && operator but via a ternary ending in null. Trigger: conditional rendering of an element in a JSX tree. Anchor: cond ? <X /> : null instead of cond && <X />. (20/20)
- MUST: A component without props reads its context directly from the store rather than receiving it via prop drilling. Trigger: screen or tab component declared without a parameter. Anchor: a useUiSelector, useUiState or useActions call in the body. — consistency, non-blocking (8/8)
- SHOULD: Classes specific to a component come from a CSS Module imported alongside it, global classes remaining reserved for shared primitives. Trigger: need for a style class in a component's render. Anchor: import styles from "./X.module.css" then className={styles.y}. — consistency, non-blocking (20/20)
- MUST: A props interface is named after the component suffixed with Props and is exported. Trigger: props declared via an interface rather than an inline annotation. Anchor: export interface ComponentNameProps. — consistency, non-blocking (4/4)
- SHOULD: Composite displayed text is rendered via a single template literal in braces rather than a mix of raw text and interpolations. Trigger: JSX text combining values and separators. Anchor: {`... ${value} ...`} as the sole text child. — consistency, non-blocking (20/20)
