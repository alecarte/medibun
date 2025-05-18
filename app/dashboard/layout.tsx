import { ClientAppShell } from '../components/layouts/ClientAppShell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ClientAppShell>{children}</ClientAppShell>;
}
