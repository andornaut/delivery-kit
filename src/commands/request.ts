// Placeholder until the request port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const request: Handler = (io) => {
  io.err("delivery-kit: request is not implemented in this build\n");
  return EXIT_USAGE;
};
