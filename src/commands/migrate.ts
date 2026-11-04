// Placeholder until the migrate port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const migrate: Handler = (io) => {
  io.err("delivery-kit: migrate is not implemented in this build\n");
  return EXIT_USAGE;
};
