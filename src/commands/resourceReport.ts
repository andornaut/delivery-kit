// Placeholder until the resourceReport port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const resourceReport: Handler = (io) => {
  io.err("delivery-kit: resource-report is not implemented in this build\n");
  return EXIT_USAGE;
};
