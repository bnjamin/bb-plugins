// REST/CLI error bodies may contain credentials or signed desktop URLs.
// Only expose our own diagnostics and Boat's structured error code.
export class BoatCommandError extends Error {
  constructor(public readonly operation: string, public readonly notFound: boolean, public readonly readinessFailed: boolean, public readonly code?: string, options?: ErrorOptions) {
    super(`Boat ${operation} failed. Check Boat login, billing scope, and sandbox state with the Boat CLI.`, options);
  }
}
