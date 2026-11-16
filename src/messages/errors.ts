export class MessageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`message: ${code}`);
    this.code = code;
    this.name = "MessageError";
  }
}
