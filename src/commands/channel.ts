// Placeholder until the channel port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const channel: Handler = (io) => {
  io.err("delivery-kit: channel is not implemented in this build\n");
  return EXIT_USAGE;
};
