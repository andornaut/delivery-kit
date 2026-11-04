// CLEANUP (added 2026-11-03): remove this command with src/migrate/ once both skills use only
// config.json and var/registry.json, every game has completed one clean 1.x cycle and no process
// references an old path.
//
// migrate [--game ID] [--dry-run] [--harness claude|codex]
// migrate --remove-legacy [--dry-run]
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { runMigration, runRemoveLegacy } from "../migrate/migrate.ts";
import { readRegistrySources } from "../migrate/registryBuild.ts";
import { procProbe } from "../migrate/runnerRecord.ts";
import { type Harness, HARNESSES } from "../registry/schema.ts";

export const MIGRATE_USAGE = `usage: delivery-kit migrate [--game ID] [--dry-run] [--harness claude|codex]
       delivery-kit migrate --remove-legacy [--dry-run]
`;

export const migrate: Handler = (io, root, args) => {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "dry-run": { type: "boolean" },
        game: { type: "string" },
        harness: { type: "string" },
        "remove-legacy": { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    io.err(
      `delivery-kit: ${error instanceof Error ? error.message : String(error)}\n${MIGRATE_USAGE}`,
    );
    return EXIT_USAGE;
  }
  const harness = values.harness;
  if (harness !== undefined && !(HARNESSES as readonly string[]).includes(harness)) {
    io.err(`delivery-kit: --harness must be claude or codex\n${MIGRATE_USAGE}`);
    return EXIT_USAGE;
  }
  const removeLegacy = values["remove-legacy"] === true;
  if (removeLegacy && (values.game !== undefined || harness !== undefined)) {
    io.err(`delivery-kit: --remove-legacy takes only --dry-run\n${MIGRATE_USAGE}`);
    return EXIT_USAGE;
  }
  let layout: Layout;
  try {
    layout = loadLayout(root);
  } catch (error) {
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
  if (values.game !== undefined && !Object.hasOwn(layout.config.games, values.game)) {
    io.err(`delivery-kit: unknown game: ${values.game}\n`);
    return EXIT_USAGE;
  }
  const dryRun = values["dry-run"] === true;
  const reporter = { err: io.err, out: io.out };
  const status = removeLegacy
    ? runRemoveLegacy(reporter, layout, procProbe, dryRun)
    : runMigration(reporter, layout, {
        dryRun,
        home: io.env.HOME ?? homedir(),
        readSources: () => readRegistrySources(layout, io.env),
        ...(values.game === undefined ? {} : { game: values.game }),
        ...(harness === undefined ? {} : { harness: harness as Harness }),
      });
  return status === 0 ? EXIT_OK : EXIT_INVALID;
};
