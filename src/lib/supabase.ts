import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// The URL and publishable key are safe to ship to the browser: access is controlled by
// row-level security policies in supabase/migrations.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null
export const cloudEnabled = !!supabase
