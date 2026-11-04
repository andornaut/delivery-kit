// Placeholder until the run port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const run: Handler = (io) => {
  io.err("delivery-kit: run is not implemented in this build\n");
  return EXIT_USAGE;
};
