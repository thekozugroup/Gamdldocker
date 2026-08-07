import type { Metadata } from 'next'
import { SettingsPage } from './settings-view'

export const metadata: Metadata = {
  title: 'Settings',
  description: 'How and where things download',
}

export default function Page() {
  return <SettingsPage />
}
