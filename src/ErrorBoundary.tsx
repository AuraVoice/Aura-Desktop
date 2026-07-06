import { Component, type ErrorInfo, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { GlassSurface } from "./overlay/GlassSurface";
import { logError } from "./lib/log";
import { captureException } from "./lib/sentry";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render errors anywhere below it so a bug in one part of the
 * overlay shows a recoverable message instead of blanking the whole window
 * with nothing on screen and nothing reported. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError("ErrorBoundary", error);
    captureException(error, { componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <GlassSurface className="error-boundary">
        <p className="error-boundary-heading">Something went wrong.</p>
        <p className="error-boundary-body">Buddy hit an unexpected error. Restarting should fix it.</p>
        <button
          type="button"
          className="error-boundary-button"
          onClick={() => void relaunch()}
        >
          Restart
        </button>
      </GlassSurface>
    );
  }
}
