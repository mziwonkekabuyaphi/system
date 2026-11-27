ZozoWeb: upload steps
1. Upload every file in this zip over your repo (same paths). If you uploaded any of your separate site zips, remove their
   older migrations (shisha / events / booking / orders / free_subdomain): this ONE migration replaces them all.
2. Run supabase/migrations/20261127200000_zozoweb.sql in Supabase (safe to run twice).
3. Vercel > Environment Variables: NEXT_PUBLIC_SITES_DOMAIN = your free-sites domain (e.g. zozoweb.co.za). Redeploy.
   Use a domain that is NOT under your platform domain.
4. Vercel > Domains: add zozoweb.co.za AND *.zozoweb.co.za (wildcard needs the domain's DNS on Vercel nameservers).
5. Platform > Modules: switch on "ZozoWeb website" per business. They then see Settings > Website.
How the free address behaves: glow-salon.zozoweb.co.za shows the site only once it is Published and the module is on;
if the business has an active primary custom domain, the free address redirects there.
