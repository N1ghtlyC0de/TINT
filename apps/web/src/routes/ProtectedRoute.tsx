import { Navigate, useLocation } from 'react-router-dom';
import { loginRedirectPath } from '../lib/api';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const token = localStorage.getItem('tint_token');
  if (!token) {
    // Tras iniciar sesión, Login vuelve a la ruta pedida (?next=).
    return <Navigate to={loginRedirectPath(location.pathname, location.search)} replace />;
  }
  return <>{children}</>;
}
