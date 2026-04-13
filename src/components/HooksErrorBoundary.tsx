import { Component, Fragment, type ReactNode } from "react";

interface State {
  resetKey: number;
  nonHooksError: Error | null;
}

/**
 * Catches "Rendered more/fewer hooks than during the previous render" errors
 * and silently recovers by forcing a full remount of the subtree.
 *
 * This can happen when React tries to reconcile components with different hook
 * counts at the same fiber position (e.g. during navigation or Fast Refresh).
 * A remount with a fresh fiber tree resolves the inconsistency.
 *
 * Non-hooks errors are re-thrown so they propagate to a parent boundary.
 */
export class HooksErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { resetKey: 0, nonHooksError: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    if (
      error?.message?.includes("Rendered more hooks than during the previous render") ||
      error?.message?.includes("Rendered fewer hooks than during the previous render")
    ) {
      // Changing resetKey forces children to remount with fresh fibers,
      // clearing the inconsistent hook state.
      return { resetKey: Date.now(), nonHooksError: null };
    }
    // For non-hooks errors, store so render() can re-throw to parent boundary
    return { nonHooksError: error };
  }

  render() {
    // Re-throw non-hooks errors so they propagate to a parent error boundary
    if (this.state.nonHooksError) {
      throw this.state.nonHooksError;
    }

    return (
      <Fragment key={this.state.resetKey}>
        {this.props.children}
      </Fragment>
    );
  }
}
