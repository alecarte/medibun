'use client';

import { Logo, useMedplumProfile, AppShell as MedplumAppShell, NotificationIcon } from "@medplum/react";
import { getReferenceString, ProfileResource } from "@medplum/core";
import { IconBellRinging, IconMail, IconClipboardCheck, IconCalendar, IconShoppingCart, IconUser } from "@tabler/icons-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const profile = useMedplumProfile();
  return (
    <MedplumAppShell logo={<Logo size={24} />} version="your.version" menus={[{
      title: 'My Menu',
      links: [{
        href: '/dashboard/notifications',
        label: 'Notifications',
        icon: <IconBellRinging />
      }, {
        href: '/dashboard/appointments',
        label: 'Appointments',
        icon: <IconCalendar />
      }, {
        href: '/dashboard/products',
        label: 'Products',
        icon: <IconShoppingCart />
      }, {
        href: '/dashboard/profile',
        label: 'Profile',
        icon: <IconUser />
      }]
    }]} displayAddBookmark={true} notifications={<>
      <NotificationIcon label="Mail" resourceType="Communication" countCriteria={`recipient=${getReferenceString(profile as ProfileResource)}&status:not=completed&_summary=count`} subscriptionCriteria={`Communication?recipient=${getReferenceString(profile as ProfileResource)}`} iconComponent={<IconMail />} onClick={() => console.log('foo')} />
      <NotificationIcon label="Tasks" resourceType="Task" countCriteria={`owner=${getReferenceString(profile as ProfileResource)}&status:not=completed&_summary=count`} subscriptionCriteria={`Task?owner=${getReferenceString(profile as ProfileResource)}`} iconComponent={<IconClipboardCheck />} onClick={() => console.log('foo')} />
    </>}>
      {children}
    </MedplumAppShell>
  );
}