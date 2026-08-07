import type { Metadata } from 'next'
import { LibraryPage } from './library-view'

export const metadata: Metadata = {
  title: 'Library',
  description: 'Your Apple Music playlists',
}

export default function Page() {
  return <LibraryPage />
}
