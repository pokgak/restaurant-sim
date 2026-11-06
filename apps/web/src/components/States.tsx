interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

export function TraceAlert({ message }: { message: string }) {
  return (
    <div className="trace-alert" role="alert">
      <strong>Trace export unavailable</strong>
      <span>{message}</span>
    </div>
  );
}

export function LoadingState() {
  return (
    <main className="dashboard-shell" aria-busy="true" aria-label="Loading observer dashboard">
      <div className="loading-bar skeleton">
        <div className="loading-status" role="status">
          <i aria-hidden="true" />
          <span>
            <strong>Connecting to telemetry</strong>
            Waiting for the first public episode snapshot…
          </span>
        </div>
      </div>
      <div className="loading-grid">
        <div className="loading-primary">
          <div className="loading-card skeleton tall" />
          <div className="loading-card skeleton medium" />
        </div>
        <div className="loading-side">
          <div className="loading-card skeleton medium" />
          <div className="loading-card skeleton tall" />
        </div>
      </div>
    </main>
  );
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <main className="state-shell">
      <section className="error-panel" role="alert" aria-labelledby="error-title">
        <div className="error-symbol" aria-hidden="true">!</div>
        <p className="eyebrow">Telemetry interruption</p>
        <h1 id="error-title">Observer feed unavailable</h1>
        <p>{message}</p>
        <button type="button" className="primary-button" onClick={onRetry}>
          Retry connection
        </button>
      </section>
    </main>
  );
}
