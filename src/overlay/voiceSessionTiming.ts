export function shouldArmInitialAgentSilenceWatchdog(
  assistantOutputAlreadyReceived: boolean,
): boolean {
  return !assistantOutputAlreadyReceived;
}
