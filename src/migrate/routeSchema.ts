// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts), once the
// runtime route parser in src/monitor/ validates what migrate writes.
//
// var/route.json schema 1 as docs/1.0-plan.md ("Harness handoff as a switch") defines it:
// {"schema":1,"state":"active"|"held","host":<game>,"monitor":<role>,"targets":[<role>...]}.
// Every name is a role key in config.json and the host is a configured game. The route names
// roles only, never conversation IDs.
import { type GameDevConfig, roleKeys } from "../layout.ts";
import { checkArray, checkEnum, checkObject, Issues, type Json } from "../validate.ts";

export const ROUTE_STATES = ["active", "held"] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export interface RouteV1 {
  readonly schema: 1;
  readonly state: RouteState;
  readonly host: string;
  readonly monitor: string;
  readonly targets: readonly string[];
}

/** Validate a schema 1 route against config.json; throws a ValidationError listing every issue. */
export function validateRoute(config: GameDevConfig, value: unknown): RouteV1 {
  const issues = new Issues();
  const shape = { required: ["schema", "state", "host", "monitor", "targets"] };
  if (checkObject(issues, "", shape, value)) {
    const route: Json = value;
    const keys = new Set(roleKeys(config));
    if (route.schema !== 1) {
      issues.add("/schema", "must be 1");
    }
    checkEnum(issues, "/state", ROUTE_STATES, route.state);
    if (typeof route.host !== "string" || !Object.hasOwn(config.games, route.host)) {
      issues.add("/host", "must be a game in config.json");
    }
    if (typeof route.monitor !== "string" || !keys.has(route.monitor)) {
      issues.add("/monitor", "must be a role key in config.json");
    }
    if (checkArray(issues, "/targets", { unique: true }, route.targets)) {
      route.targets.forEach((target, index) => {
        if (typeof target !== "string" || !keys.has(target)) {
          issues.add(`/targets/${index}`, "must be a role key in config.json");
        }
      });
    }
  }
  issues.throwIfAny("route.json");
  return value as RouteV1;
}
