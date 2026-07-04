import { AuthProvider } from "./state/AuthProvider";
import { OverlayRoot } from "./overlay/OverlayRoot";
import "./App.css";

function App() {
  return (
    <AuthProvider>
      <OverlayRoot />
    </AuthProvider>
  );
}

export default App;
