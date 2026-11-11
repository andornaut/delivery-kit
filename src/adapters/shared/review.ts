// The instruction every scheduled review carries: find each hold, block and pending
// user decision, and get it surfaced to the user or released.
export const UNBLOCK_INSTRUCTIONS =
  "Find every hold, block and pending user decision. For a pending decision, make sure its owner " +
  "has it open as a structured prompt in its own session with its recommendation first; if not, " +
  "ask the owner to open it now, then list it for the user with owner, exact text, options and " +
  "where to answer. For a hold, if its reason no longer applies, tell the owner it is released " +
  "and to resume approved work; if it still applies, name the exact blocker and the role that " +
  "can clear it. For a block, send the exact request to the role that can clear it. Never " +
  "answer, cancel or clear another owner's question, and never make a user decision yourself.";
