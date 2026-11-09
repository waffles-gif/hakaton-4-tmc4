import { Navigate, RouterProvider, createBrowserRouter } from 'react-router'
import { HealthGate } from './components/HealthGate'
import { Layout } from './components/Layout'
import { FullScreenLoader, RequireAuth, RequirePermission } from './components/guards'
import { AuthProvider } from './lib/auth'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'
import RegisterPage from './pages/RegisterPage'
import RouteError from './pages/RouteError'

// Las páginas pesadas se cargan con lazy (code splitting): no entran en el bundle de /login.
const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    hydrateFallbackElement: <FullScreenLoader label="Cargando…" />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Layout />,
            errorElement: <RouteError />,
            children: [
              { index: true, element: <Navigate to="/files" replace /> },
              {
                path: '/estado',
                lazy: async () => ({ Component: (await import('./pages/EstadoPage')).default }),
              },
              {
                element: <RequirePermission perm="files:read" />,
                children: [
                  {
                    path: '/files',
                    lazy: async () => ({ Component: (await import('./pages/FilesPage')).default }),
                  },
                  {
                    path: '/files/:id/refine',
                    lazy: async () => ({ Component: (await import('./pages/RefinePage')).default }),
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])

export default function App() {
  return (
    <HealthGate>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </HealthGate>
  )
}
