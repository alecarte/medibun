import { AppShell } from '../components/layouts/AppShell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
