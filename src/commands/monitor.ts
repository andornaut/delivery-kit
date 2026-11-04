// Placeholder until the monitor port lands.
import { EXIT_USAGE, type Handler } from "../io.ts";

export const monitorAck: Handler = (io) => {
  io.err("delivery-kit: monitor-ack is not implemented in this build\n");
  return EXIT_USAGE;
};

export const monitorSnapshot: Handler = (io) => {
  io.err("delivery-kit: monitor-snapshot is not implemented in this build\n");
  return EXIT_USAGE;
};
