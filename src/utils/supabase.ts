import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_PROJECT_URL as string, process.env.SUPABASE_PUBLIC_ANON as string);

export default supabase;