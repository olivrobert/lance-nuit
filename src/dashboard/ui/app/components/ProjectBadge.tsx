// The project chip shown on a row and in the sheet meta panel: the project
// name, with its path and provider as a tooltip when the project is known.
//
// It reads the project list from the query cache itself rather than taking it
// as a prop: every caller already has a name and nothing else, and threading
// the whole project list through the list and the sheet just to reach this one
// leaf would be prop-drilling for nothing. It uses the
// global `.proj` primitive from `styles/tokens.css`, not a CSS Module, so
// every consumer shares one class.

import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsQuery } from "../api/queries.js";

export function ProjectBadge({ name }: { name: string }): JSX.Element {
  const project = useQuery(projectsQuery).data?.find((entry) => entry.name === name);
  const title = project ? `${project.cwd} · ${project.provider}` : name;
  return (
    <span className="proj" title={title}>
      {name}
    </span>
  );
}
