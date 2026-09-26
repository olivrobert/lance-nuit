// modules/ui/routes/stats.ts
//
// `/api/stats`: every ticket's cost and duration. Read on request, never
// polled: the scan opens every run snapshot of every project, for figures read
// now and then.

import { sendJson, sendNotFound } from "../http/respond.js";
import type { Route } from "./route.js";

export const statsRoute: Route = {
  access: "open",
  methods: ["GET"],
  handle({ res, rest }, deps) {
    if (rest.length > 0) sendNotFound(res);
    else sendJson(res, 200, deps.readModel.stats());
  },
};
