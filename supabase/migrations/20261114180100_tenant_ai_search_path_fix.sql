-- Pin search_path on the two AI trigger helpers (Supabase advisor: function_search_path_mutable).
alter function public.ai_set_updated_at()            set search_path = public;
alter function public.ai_usage_ledger_block_update() set search_path = public;
