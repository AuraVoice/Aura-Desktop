import { useAuth } from "../state/AuthProvider";
import PairingScreen from "./PairingScreen";
import SignOutPanel from "./SignOutPanel";
import "./DashboardView.css";

function DashboardView() {
  const { user, initializing } = useAuth();

  return (
    <div className="dashboard-view">
      <header className="dashboard-header" data-tauri-drag-region>
        <span className="dashboard-title">Aura</span>
      </header>
      <main className="dashboard-body">
        {initializing ? (
          <p className="dashboard-placeholder">Loading...</p>
        ) : user ? (
          <>
            <p className="dashboard-placeholder">
              Signed in. Linked devices and settings aren't built yet.
            </p>
            <SignOutPanel />
          </>
        ) : (
          <PairingScreen />
        )}
      </main>
    </div>
  );
}

export default DashboardView;
