import type { Metadata } from 'next'
import { ActivityPage } from './activity-view'

export const metadata: Metadata = {
  title: 'Activity',
  description: 'Live downloader output',
}

export default function Page() {
  return <ActivityPage />
}
