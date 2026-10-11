export type DesktopUpdateFailureReason =
  | "browserCleanup"
  | "installerLaunch"
  | "installationUnconfirmed"
  | "startupMismatch";

export type DesktopUpdateResult =
  | { state: "succeeded"; fromVersion: string; version: string }
  | { state: "installedRelaunchUnconfirmed"; version: string }
  | {
      state: "failedOrInterrupted";
      fromVersion: string;
      expectedVersion: string;
      reason: DesktopUpdateFailureReason;
    };

export interface DesktopUpdateResultSummary {
  tone: "success" | "warning" | "error";
  title: string;
  detail: string;
}

const FAILURE_REASONS = new Set<DesktopUpdateFailureReason>([
  "browserCleanup",
  "installerLaunch",
  "installationUnconfirmed",
  "startupMismatch",
]);

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function parseDesktopUpdateResult(value: unknown): DesktopUpdateResult | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") {
    throw new Error("AliasMode returned an invalid update result.");
  }
  const result = value as Record<string, unknown>;
  if (
    result.state === "succeeded" &&
    isVersion(result.fromVersion) &&
    isVersion(result.version)
  ) {
    return {
      state: "succeeded",
      fromVersion: result.fromVersion,
      version: result.version,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed" && isVersion(result.version)) {
    return { state: "installedRelaunchUnconfirmed", version: result.version };
  }
  if (
    result.state === "failedOrInterrupted" &&
    isVersion(result.fromVersion) &&
    isVersion(result.expectedVersion) &&
    typeof result.reason === "string" &&
    FAILURE_REASONS.has(result.reason as DesktopUpdateFailureReason)
  ) {
    return {
      state: "failedOrInterrupted",
      fromVersion: result.fromVersion,
      expectedVersion: result.expectedVersion,
      reason: result.reason as DesktopUpdateFailureReason,
    };
  }
  throw new Error("AliasMode returned an invalid update result.");
}

// The recovery hints name what each system offers: the Start menu and offline installer, or Applications and the install command.
const MAC = typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);
const REOPEN = MAC ? "open it from the Applications folder" : "launch it from Windows Start";
const REINSTALL = MAC ? "run the install command again" : "run the full offline installer without uninstalling";

export function describeDesktopUpdateResult(result: DesktopUpdateResult): DesktopUpdateResultSummary {
  if (result.state === "succeeded") {
    return {
      tone: "success",
      title: `AliasMode ${result.version} installed successfully.`,
      detail: `Updated from ${result.fromVersion} and verified the installed app after restart.`,
    };
  }
  if (result.state === "installedRelaunchUnconfirmed") {
    return {
      tone: "warning",
      title: `AliasMode ${result.version} is installed.`,
      detail: `The automatic restart was not confirmed. Close AliasMode, then ${REOPEN}.`,
    };
  }

  const detail = result.reason === "browserCleanup"
    ? `AliasMode ${result.fromVersion} remains installed because browser services could not close safely.`
    : result.reason === "installerLaunch"
      ? `AliasMode ${result.expectedVersion} could not start. AliasMode ${result.fromVersion} remains installed.`
      : result.reason === "startupMismatch"
        ? `AliasMode could not verify ${result.expectedVersion} at the expected install location. Close AliasMode, then ${REOPEN}.`
        : `AliasMode could not confirm ${result.expectedVersion}. If the installed version did not change, ${REINSTALL}.`;
  return {
    tone: "error",
    title: "The last update did not finish.",
    detail,
  };
}
