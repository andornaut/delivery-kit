// @andornaut/delivery-kit/transport: endpoint selection without probing or activation.
export {
  type CodexControlSocketEndpoint,
  type CodexControlSocketOptions,
  resolveCodexControlSocket,
} from "./adapters/shared/endpoints.ts";
export type { DeliveryDiagnostic, NativeRpcCode } from "./adapters/types.ts";
export { messageChannelStateDir } from "./messages/paths.ts";
