import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// The URL and publishable key are safe to ship to the browser: access is controlled by
// row-level security policies in supabase/migrations.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

// read before the client tidies the address bar: did this page open from the email link?
export const arrivedByLink = typeof window !== 'undefined' && /access_token=|[?&]code=|token_hash=/.test(window.location.hash + window.location.search)
export const supabase: SupabaseClient | null = url && key ? createClient(url, key, {
  // stay signed in until signing out: keep the session in localStorage and refresh it quietly
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null
export const cloudEnabled = !!supabase
