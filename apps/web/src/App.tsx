import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CreateRoom from './pages/CreateRoom';
import InviteLanding from './pages/InviteLanding';
import WatchRoom from './pages/WatchRoom';
import ProtectedRoute from './routes/ProtectedRoute';
// Carga diferida: la ruta oculta no debe sumar framer-motion al bundle principal.
const TestMe = lazy(() => import('./pages/TestMe'));
// Carga diferida: la analítica solo la abre el host y no debe pesar en el bundle principal.
const RoomAnalytics = lazy(() => import('./pages/RoomAnalytics'));
//import Demo from './pages/Demo'; // opcional: mover vista original aquí

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite/:code" element={<InviteLanding />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/rooms/new" element={<ProtectedRoute><CreateRoom /></ProtectedRoute>} />
        <Route path="/rooms/:id" element={<ProtectedRoute><CreateRoom /></ProtectedRoute>} />
        <Route
          path="/rooms/:id/analytics"
          element={<ProtectedRoute><Suspense fallback={null}><RoomAnalytics /></Suspense></ProtectedRoute>}
        />
        <Route path="/watch/:roomId" element={<WatchRoom />} />
        {/* Ruta oculta: cuestionario del monorepo, sin enlaces desde la UI. */}
        <Route path="/test-me" element={<Suspense fallback={null}><TestMe /></Suspense>} />
        {/* <Route path="/demo" element={<Demo />} /> */}
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}