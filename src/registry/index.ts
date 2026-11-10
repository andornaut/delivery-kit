// @andornaut/delivery-kit/registry: the typed public registry module.
export {
  type GameDevConfig,
  type GameEntry,
  type GameLayout,
  gameLayout,
  type KitEntry,
  type Layout,
  loadLayout,
  roleKeys,
  UnknownGame,
  validateGameDevConfig,
} from "../layout.ts";
export { LockBusy, LockError } from "../lock.ts";
export { ValidationError } from "../validate.ts";
export {
  AmbiguousRole,
  resolveConversation,
  resolveHarness,
  resolveRole,
  UnknownRole,
} from "./resolve.ts";
export {
  type Activation,
  type Adoption,
  type Harness,
  HARNESSES,
  type Mutable,
  type Operation,
  type Registry,
  type RegistryDraft,
  RegistrySchema,
  type RoleRecord,
  type Transfer,
  TRANSFER_PHASES,
  type TransferPhase,
  validateRegistry,
} from "./schema.ts";
export {
  type HarnessSelection,
  resolveSelectedRoles,
  type RoleSelection,
  selectHarness,
} from "./selection.ts";
export {
  createRegistry,
  readRegistry,
  RegistryExists,
  RegistryMissing,
  RevisionConflict,
  type UpdateOptions,
  updateRegistry,
} from "./store.ts";
