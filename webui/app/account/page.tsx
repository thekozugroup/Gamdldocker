import type { Metadata } from 'next'
import { AccountPage } from './account-view'

export const metadata: Metadata = {
  title: 'Account',
  description: 'Apple Music sign-in',
}

export default function Page() {
  return <AccountPage />
}
