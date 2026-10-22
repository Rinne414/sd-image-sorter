import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from '../api/queryClient'
import { NextApp } from './NextApp'
import './design/tokens.css'
import './design/base.css'

// The new interface at /next/ (docs/DESIGN.md §redesign-2026-10). It shares
// frontend-v4's data layer and feature components and draws them with its own
// tokens, shell and library page.

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from next.html')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <NextApp />
    </QueryClientProvider>
  </StrictMode>,
)
