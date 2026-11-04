// Placeholder until the status port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const status: Handler = (io) => {
  io.err("delivery-kit: status is not implemented in this build\n");
  return EXIT_USAGE;
};
