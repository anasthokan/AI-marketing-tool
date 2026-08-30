import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import "bootstrap-icons/font/bootstrap-icons.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/ai" element={<Dashboard />} />
        <Route path="/manual" element={<Dashboard />} />
        <Route path="/ai-video" element={<Dashboard />} />
        <Route path="/video" element={<Navigate to="/ai-video" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
