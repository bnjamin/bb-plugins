// Only display known, static guidance. Unexpected transport errors may contain secrets.
export function shareErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("App is not ready.")) return "The app is not running or its port could not be found. Set this project’s development command and port in Settings → Plugins → Boat Sandboxes, then retry. Apps must be restarted after a sandbox resumes.";
  if (message === "This thread is not on a Boat machine." || message.startsWith("This thread has no environment.")) return "This thread does not use a Boat sandbox. Open a thread on a Boat machine to share its app.";
  if (message.startsWith("Resume the thread's Boat machine")) return "The Boat machine is not connected. Resume it before sharing the app.";
  if (message.startsWith("Development exited before the app was ready.")) return "The development command exited before the app was ready. Check the Boat development terminal for errors, then retry.";
  if (message.startsWith("A preview is already starting")) return "A preview is already starting in this environment. Wait for it to finish, then retry.";
  return "Could not prepare the preview. Run bb boat share in this thread’s terminal for diagnostic details, then retry.";
}
